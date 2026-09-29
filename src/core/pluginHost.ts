/**
 * 插件宿主（主线程侧）
 *
 * 职责与 MusicFreeDesktop 的 pluginHost.ts 一致：
 *  - 管理 Worker 里的插件实例（挂载 / 卸载 / 调用）；
 *  - 插件源码持久化在 IndexedDB（桌面端是 plugins/<hash>.js 文件，hash 同为 sha256(源码)）；
 *  - 元信息存 localStorage `plugin.meta`（结构与桌面端 configStore 的同名 key 一致）；
 *  - 安装 / 升级 / 聚合源导入 / 备份恢复语义与桌面端对齐。
 */

import { getProxyBase, netFetchText } from "./net";
import { hasNativeHttp, nativeHttpRequest } from "./native";
import { compare } from "compare-versions";

export type PluginState = "Mounted" | "Error";

export interface SerializedPlugin {
    name: string;
    hash: string;
    platform: string;
    version: string;
    srcUrl: string;
    author: string;
    description: string;
    state: PluginState;
    errorReason?: string;
    enabled: boolean;
    order: number;
    userVariables: Record<string, string>;
    userVariablesDef?: any;
    supportedMethods: string[];
}

interface PluginMeta {
    enabled?: boolean;
    order: number;
    userVariables: Record<string, string>;
}

/** 备份文件里的插件条目（与桌面端 IBackupPlugin 一致） */
export interface IBackupPlugin {
    platform: string;
    srcUrl: string;
    version: string;
    enabled: boolean;
    order: number;
    userVariables: Record<string, string>;
    code?: string;
}

export interface IPluginResumeResult {
    installed: number;
    updated: number;
    skipped: number;
    failed: { platform: string; reason: string }[];
}

export interface IPluginInstallResult {
    success: boolean;
    message?: string;
    pluginName?: string;
    pluginHash?: string;
    pluginUrl?: string;
    duplicated?: boolean;
    errorCode?: "IS_PLUGIN_INDEX";
}

export interface IInstallOrUpdateResult {
    status: "installed" | "updated" | "unchanged" | "failed";
    name: string;
    reason?: string;
}

const META_KEY = "plugin.meta";
const DB_NAME = "musicfree-pad";
const CODE_STORE = "pluginCode";

/** ---------------- IndexedDB 小封装 ---------------- */

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(CODE_STORE)) {
                db.createObjectStore(CODE_STORE, { keyPath: "hash" });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("IndexedDB 打开失败"));
    });
}

async function idbPut(store: string, value: any) {
    const db = await openDb();
    return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).put(value);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function idbGet<T = any>(store: string, key: string): Promise<T | undefined> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readonly");
        const req = tx.objectStore(store).get(key);
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
    });
}

async function idbDelete(store: string, key: string) {
    const db = await openDb();
    return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/** ---------------- 宿主 ---------------- */

function looksLikeJson(data: any): boolean {
    if (data === null || data === undefined) {
        return false;
    }
    if (typeof data === "object") {
        return true;
    }
    const text = String(data).trimStart();
    if (text.charAt(0) !== "{" && text.charAt(0) !== "[") {
        return false;
    }
    try {
        JSON.parse(text);
        return true;
    } catch {
        return false;
    }
}

/** 按插件声明的版本号排序用；插件常写 "dev" / 空串，交给 compare 会抛错 */
function versionOf(plugin: { version?: string } | undefined): string {
    const v = plugin?.version;
    return typeof v === "string" && v.length ? v : "0.0.0";
}

function isVersionNotOlder(a: string, b: string): boolean {
    try {
        return compare(a, b, ">=");
    } catch {
        return a >= b;
    }
}

interface WorkerPending {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    timer: ReturnType<typeof setTimeout>;
}

class WebPluginHost {
    private worker: Worker | null = null;
    private ready: Promise<void> | null = null;
    private pending = new Map<number, WorkerPending>();
    private msgId = 0;
    private plugins = new Map<string, SerializedPlugin & { __code?: string }>();
    private meta: Record<string, PluginMeta> = {};

    private readMeta() {
        try {
            this.meta = JSON.parse(localStorage.getItem(META_KEY) ?? "{}") ?? {};
        } catch {
            this.meta = {};
        }
        if (typeof this.meta !== "object" || this.meta === null) {
            this.meta = {};
        }
    }

    private writeMeta() {
        localStorage.setItem(META_KEY, JSON.stringify(this.meta));
    }

    private saveMeta(hash: string, patch: Partial<PluginMeta>) {
        this.meta[hash] = {
            order: this.meta[hash]?.order ?? this.plugins.size,
            userVariables: this.meta[hash]?.userVariables ?? {},
            enabled: this.meta[hash]?.enabled ?? true,
            ...patch,
        };
        this.writeMeta();
        const plugin = this.plugins.get(hash);
        if (plugin) {
            plugin.enabled = this.meta[hash].enabled ?? true;
            plugin.order = this.meta[hash].order;
            plugin.userVariables = this.meta[hash].userVariables;
        }
    }

    /** 初始化 Worker 并从 IndexedDB 恢复所有插件 */
    async setup(): Promise<void> {
        if (this.ready) {
            return this.ready;
        }
        this.ready = this.doSetup().catch((e) => {
            // 初始化失败不缓存 rejected promise：允许下次调用重试
            this.ready = null;
            try {
                this.worker?.terminate();
            } catch {
                // ignore
            }
            this.worker = null;
            throw e;
        });
        return this.ready;
    }

    private async doSetup() {
        this.readMeta();
        this.worker = new Worker(new URL("./pluginWorker.ts", import.meta.url), {
            type: "module",
        });
        this.worker.onmessage = (ev: MessageEvent) => this.onWorkerMessage(ev);
        this.worker.onerror = (e) => {
            console.error("[pluginHost] worker error", e);
        };
        await this.postToWorker(
            "init",
            { proxyBase: getProxyBaseForWorker(), nativeHttp: hasNativeHttp() },
            10000,
        );

        const db = await openDb();
        const codes: { hash: string; code: string }[] = await new Promise((resolve, reject) => {
            const tx = db.transaction(CODE_STORE, "readonly");
            const req = tx.objectStore(CODE_STORE).getAll();
            req.onsuccess = () => resolve(req.result ?? []);
            req.onerror = () => reject(req.error);
        });
        for (const { hash, code } of codes) {
            await this.mountPersisted(hash, code);
        }
    }

    private async mountPersisted(hash: string, code: string) {
        const info = await this.postToWorker("mount", { code });
        if (!info || info.state !== "Mounted" || info.hash !== hash) {
            // 源码在但挂载失败（版本不满足 / 解析失败）：登记错误态，界面可见原因
            this.plugins.set(hash, {
                name: info?.name ?? "",
                hash: info?.hash ?? hash,
                platform: info?.name ?? "",
                version: info?.version ?? "",
                srcUrl: info?.srcUrl ?? "",
                author: info?.author ?? "",
                description: info?.description ?? "",
                state: "Error",
                errorReason: info?.errorReason ?? "CannotParse",
                enabled: this.meta[hash]?.enabled ?? true,
                order: this.meta[hash]?.order ?? 999,
                userVariables: this.meta[hash]?.userVariables ?? {},
                supportedMethods: info?.supportedMethods ?? [],
            });
            return;
        }
        this.plugins.set(hash, {
            name: info.name,
            hash,
            platform: info.name,
            version: info.version,
            srcUrl: info.srcUrl,
            author: info.author,
            description: info.description,
            state: "Mounted",
            enabled: this.meta[hash]?.enabled ?? true,
            order: this.meta[hash]?.order ?? 999,
            userVariables: this.meta[hash]?.userVariables ?? {},
            userVariablesDef: info.userVariablesDef,
            supportedMethods: info.supportedMethods,
        });
        // Worker 挂载时用户变量恒为空，冷启动后要把持久化的变量回灌进去
        const savedVars = this.meta[hash]?.userVariables;
        if (savedVars && Object.keys(savedVars).length) {
            this.postToWorker("setUserVariables", { hash, userVariables: savedVars }).catch(
                () => undefined,
            );
        }
    }

    private onWorkerMessage(ev: MessageEvent) {
        const msg = ev.data ?? {};
        if (msg.type === "result" && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!;
            clearTimeout(p.timer);
            this.pending.delete(msg.id);
            if (msg.ok) {
                p.resolve(msg.data);
            } else {
                p.reject(new Error(msg.error ?? "插件调用失败"));
            }
            return;
        }
        if (msg.type === "net") {
            // Worker 请求宿主代发网络请求（原生模式：走 CapacitorHttp 原生网络栈）
            this.handleWorkerNet(msg);
        }
    }

    private async handleWorkerNet(msg: any) {
        const netId = msg.netId;
        try {
            const req = msg.req ?? {};
            let payload: { status: number; headers: Record<string, string>; text: string };
            if (hasNativeHttp()) {
                payload = await nativeHttpRequest({
                    url: req.url,
                    method: req.method ?? "GET",
                    headers: req.headers,
                    body: req.body,
                    timeoutMs: 30000,
                });
            } else {
                const res = await fetch(req.url, {
                    method: req.method ?? "GET",
                    headers: req.headers,
                    body:
                        (req.method ?? "GET").toUpperCase() === "GET" ||
                        (req.method ?? "GET").toUpperCase() === "HEAD"
                            ? undefined
                            : req.body,
                    credentials: "omit",
                });
                const text = await res.text();
                const headers: Record<string, string> = {};
                res.headers.forEach((v, k) => {
                    headers[k.toLowerCase()] = v;
                });
                payload = { status: res.status, headers, text };
            }
            this.worker?.postMessage({ type: "netResult", netId, ok: true, payload });
        } catch (e: any) {
            this.worker?.postMessage({
                type: "netResult",
                netId,
                ok: false,
                error: e?.message ?? String(e),
            });
        }
    }

    private postToWorker(type: string, payload: any, timeoutMs = 60000): Promise<any> {
        const worker = this.worker;
        if (!worker) {
            return Promise.reject(new Error("插件宿主未就绪"));
        }
        const id = ++this.msgId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error("插件宿主响应超时"));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            worker.postMessage({ type, id, ...payload });
        });
    }

    /** 调用插件方法（30s 超时，与桌面端 pluginCall 一致） */
    async callMethod<T = any>(hash: string, method: string, ...args: any[]): Promise<T> {
        await this.setup();
        const plugin = this.plugins.get(hash);
        if (!plugin) {
            throw new Error("插件不存在或已卸载");
        }
        if (!(this.meta[hash]?.enabled ?? true)) {
            throw new Error("插件已被禁用");
        }
        const res = await this.postToWorker(
            "call",
            { hash, method, args },
            30000,
        );
        return res as T;
    }

    getSerializedPlugins(): SerializedPlugin[] {
        return [...this.plugins.values()]
            .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
            .map(({ __code, ...rest }) => rest as SerializedPlugin);
    }

    getPluginByHash(hash: string) {
        return this.plugins.get(hash);
    }

    /** ---------- 安装 ---------- */

    /** 用一段插件源码安装/替换插件（replaceHash 为升级时被替换的旧 hash） */
    async installPluginCode(
        code: string,
        options?: { replaceHash?: string },
    ): Promise<IPluginInstallResult> {
        await this.setup();
        const info = await this.postToWorker("mount", { code });
        if (!info || info.state !== "Mounted" || !info.hash) {
            return {
                success: false,
                message: `插件无法解析：${info?.errorReason ?? "CannotParse"}`,
            };
        }
        const hash: string = info.hash;
        await idbPut(CODE_STORE, { hash, code });
        if (options?.replaceHash && options.replaceHash !== hash) {
            await this.removeInternal(options.replaceHash);
        }
        if (!this.meta[hash]) {
            this.saveMeta(hash, {
                order: this.plugins.size,
                userVariables: {},
                enabled: true,
            });
        }
        this.plugins.set(hash, {
            name: info.name,
            hash,
            platform: info.name,
            version: info.version,
            srcUrl: info.srcUrl,
            author: info.author,
            description: info.description,
            state: "Mounted",
            enabled: this.meta[hash]?.enabled ?? true,
            order: this.meta[hash]?.order ?? 999,
            userVariables: this.meta[hash]?.userVariables ?? {},
            userVariablesDef: info.userVariablesDef,
            supportedMethods: info.supportedMethods,
        });
        return {
            success: true,
            pluginName: info.name,
            pluginHash: hash,
            pluginUrl: info.srcUrl,
        };
    }

    /** 聚合源导入的安装规则（与桌面端 installOrUpdate 一致） */
    async installOrUpdate(code: string): Promise<IInstallOrUpdateResult> {
        await this.setup();
        const info = await this.postToWorker("mount", { code });
        const name = info?.name || "未知音源";
        if (!info || info.state !== "Mounted" || !info.hash) {
            return {
                status: "failed",
                name,
                reason: `无法解析：${info?.errorReason ?? "CannotParse"}`,
            };
        }
        const hash: string = info.hash;
        if (this.plugins.has(hash)) {
            return { status: "unchanged", name };
        }
        const samePlatform = [...this.plugins.values()].find((p) => p.name === name);
        if (samePlatform && isVersionNotOlder(versionOf(samePlatform), versionOf(info))) {
            return { status: "unchanged", name };
        }
        const registered = await this.installPluginCode(code, {
            replaceHash: samePlatform?.hash,
        });
        if (!registered.success) {
            return { status: "failed", name, reason: registered.message };
        }
        return { status: samePlatform ? "updated" : "installed", name };
    }

    async installPluginFromUrl(url: string): Promise<IPluginInstallResult> {
        try {
            const res = await netFetchText(url);
            if (looksLikeJson(res)) {
                return {
                    success: false,
                    errorCode: "IS_PLUGIN_INDEX",
                    message: "这是聚合源链接",
                };
            }
            const code = (res ?? "").toString();
            if (!code.length) {
                return { success: false, message: "插件源返回为空" };
            }
            return await this.installPluginCode(code);
        } catch (e: any) {
            return { success: false, message: e?.message ?? String(e) };
        }
    }

    async installPluginFromLocalFile(file: File): Promise<IPluginInstallResult> {
        try {
            const code = await file.text();
            const result = await this.installPluginCode(code);
            if (result.success && result.pluginHash) {
                const existing = this.plugins.get(result.pluginHash);
                if (existing && existing.state === "Mounted") {
                    // 覆盖 file 场景下的「重复安装」判断与桌面端一致
                }
            }
            return result;
        } catch (e: any) {
            return { success: false, message: e?.message ?? String(e) };
        }
    }

    /** 解析聚合订阅源并批量导入（顶层数组 / plugins / items 字段，条目裸 URL 或 {url|srcUrl|file}） */
    async importPluginIndex(indexUrl: string) {
        const text = await netFetchText(indexUrl);
        const parsed = JSON.parse(text);
        const entriesRaw = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed?.plugins)
              ? parsed.plugins
              : Array.isArray(parsed?.items)
                ? parsed.items
                : null;
        if (!entriesRaw) {
            throw new Error("聚合源格式无法识别");
        }
        const baseUrl = indexUrl;
        const result = {
            total: 0,
            installed: 0,
            updated: 0,
            unchanged: 0,
            failed: [] as { name: string; reason: string }[],
        };
        for (const entry of entriesRaw) {
            const url =
                typeof entry === "string"
                    ? entry
                    : entry?.url ?? entry?.srcUrl ?? entry?.file;
            if (typeof url !== "string" || !url.length) {
                continue;
            }
            const full = new URL(url, baseUrl).toString();
            result.total += 1;
            try {
                const code = await netFetchText(full);
                const st = await this.installOrUpdate(code);
                if (st.status === "installed") {
                    result.installed += 1;
                } else if (st.status === "updated") {
                    result.updated += 1;
                } else if (st.status === "unchanged") {
                    result.unchanged += 1;
                } else {
                    result.failed.push({ name: st.name, reason: st.reason ?? "安装失败" });
                }
            } catch (e: any) {
                result.failed.push({ name: url, reason: e?.message ?? String(e) });
            }
        }
        return result;
    }

    /** ---------- 管理 ---------- */

    private async removeInternal(hash: string) {
        const plugin = this.plugins.get(hash);
        if (!plugin) {
            return;
        }
        await idbDelete(CODE_STORE, hash).catch(() => undefined);
        this.postToWorker("unmount", { hash }).catch(() => undefined);
        delete this.meta[hash];
        this.writeMeta();
        this.plugins.delete(hash);
    }

    async uninstallPlugin(hash: string) {
        await this.setup();
        await this.removeInternal(hash);
    }

    setPluginEnabled(hash: string, enabled: boolean) {
        this.saveMeta(hash, { enabled });
    }

    setUserVariables(hash: string, vars: Record<string, string>) {
        this.saveMeta(hash, { userVariables: vars });
        this.postToWorker("setUserVariables", { hash, userVariables: vars }).catch(
            () => undefined,
        );
    }

    setPluginOrder(hashes: string[]) {
        hashes.forEach((hash, i) => {
            this.saveMeta(hash, { order: i });
        });
    }

    /** ---------- 备份 / 恢复 ---------- */

    async backupPlugins(): Promise<IBackupPlugin[]> {
        await this.setup();
        const list: IBackupPlugin[] = [];
        for (const p of this.plugins.values()) {
            if (p.state !== "Mounted") {
                continue;
            }
            const meta = this.meta[p.hash] ?? { order: 999, userVariables: {} };
            const item: IBackupPlugin = {
                platform: p.name,
                srcUrl: p.srcUrl ?? "",
                version: versionOf(p),
                enabled: meta.enabled ?? true,
                order: meta.order ?? 999,
                userVariables: meta.userVariables ?? {},
            };
            if (!item.srcUrl) {
                // 本地安装的插件没有 srcUrl：把源码内嵌进备份，恢复时不依赖网络
                const record = await idbGet<{ hash: string; code: string }>(
                    CODE_STORE,
                    p.hash,
                );
                if (record?.code) {
                    item.code = record.code;
                }
            }
            list.push(item);
        }
        return list.sort((a, b) => a.order - b.order);
    }

    /**
     * 恢复备份中的插件（与桌面端 resumePlugins 同语义）：
     * 本地版本已不低于备份版本 -> 只恢复启用状态/顺序/用户变量；否则按 srcUrl / 内嵌源码安装。
     */
    async resumePlugins(list: IBackupPlugin[]): Promise<IPluginResumeResult> {
        await this.setup();
        const result: IPluginResumeResult = {
            installed: 0,
            updated: 0,
            skipped: 0,
            failed: [],
        };
        for (const item of list ?? []) {
            if (!item || typeof item !== "object") {
                continue;
            }
            const srcUrl = typeof item.srcUrl === "string" ? item.srcUrl.trim() : "";
            const platform = typeof item.platform === "string" ? item.platform : "";

            let current = srcUrl
                ? [...this.plugins.values()].find((p) => (p.srcUrl ?? "") === srcUrl)
                : undefined;
            if (!current && platform) {
                current = [...this.plugins.values()].find((p) => p.name === platform);
            }

            const needsInstall =
                !current ||
                !isVersionNotOlder(versionOf(current), item.version ?? "0.0.0");

            let target: SerializedPlugin | undefined = current;
            if (needsInstall) {
                let code: string | undefined;
                if (srcUrl) {
                    try {
                        code = await netFetchText(srcUrl);
                    } catch (e: any) {
                        // 网络不通 / 浏览器跨域拦截：备份里若带了源码就地安装，别让插件直接丢
                        if (typeof item.code === "string" && item.code.length) {
                            code = item.code;
                        } else {
                            result.failed.push({
                                platform: platform || srcUrl,
                                reason: `下载失败：${e?.message ?? String(e)}`,
                            });
                            continue;
                        }
                    }
                } else if (typeof item.code === "string" && item.code.length) {
                    code = item.code;
                }
                if (!code) {
                    result.failed.push({
                        platform: platform || "未知插件",
                        reason: "备份中没有源码，且该插件不是从网络安装的，无法恢复",
                    });
                    continue;
                }
                const installRes = await this.installPluginCode(code, {
                    replaceHash: current?.hash,
                });
                if (!installRes.success || !installRes.pluginHash) {
                    result.failed.push({
                        platform: platform || "未知插件",
                        reason: installRes.message ?? "安装失败",
                    });
                    continue;
                }
                target = this.plugins.get(installRes.pluginHash);
                if (current) {
                    result.updated += 1;
                } else {
                    result.installed += 1;
                }
            } else {
                result.skipped += 1;
            }

            if (!target) {
                continue;
            }
            const userVariables =
                item.userVariables && typeof item.userVariables === "object"
                    ? item.userVariables
                    : {};
            this.saveMeta(target.hash, {
                enabled: item.enabled ?? true,
                order:
                    typeof item.order === "number"
                        ? item.order
                        : this.meta[target.hash]?.order ?? 999,
                userVariables,
            });
            this.postToWorker("setUserVariables", {
                hash: target.hash,
                userVariables,
            }).catch(() => undefined);
        }
        return result;
    }
}

/** Worker 无法读 localStorage，代理地址在 init 时传进去（原生环境恒为空，走原生 HTTP） */
function getProxyBaseForWorker(): string {
    return getProxyBase();
}

export const pluginHost = new WebPluginHost();
