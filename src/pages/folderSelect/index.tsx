import { useEffect, useRef, useState } from "react";
import { goBack } from "@/core/router";
import { addNativeListener, callNativeMethod } from "@/core/native";
import { openPrompt, showToast } from "@/core/uiAtoms";
import {
    downloadSaveTargetLabel,
    getDownloadExternalDir,
    getDownloadSaveTarget,
    getDownloadSubfolder,
    nativePlatform,
    normalizeSubfolder,
    setDownloadExternalDir,
    setDownloadSaveTarget,
    setDownloadSubfolder,
} from "@/core/musicDownload";
import {
    AUDIO_EXT_RE,
    getEffectiveScanDirs,
    requestAudioPermission,
    scanLocalMusic,
    setCustomScanDirs,
} from "@/core/localMusic";
import {
    IconBack,
    IconCheck,
    IconDownload,
    IconFolder,
    IconFolderPlus,
    IconFolderSearch,
} from "@/components/base/Icons";

/**
 * 文件夹选择页（参考网易云音乐的扫描目录页）：
 *  - 单选模式（mode="single"）：「设置 → 下载 → 保存位置」进入，浏览文件系统选定
 *    下载文件夹。Android 落成 external 目标（绝对路径，写入走 StoragePlugin）；
 *    iOS 的存储根就是沙盒 Documents，落成 documents + 相对路径。顶部保留
 *    「系统下载目录」快速项。
 *  - 多选模式（mode="multi"）：「本地音乐 → 扫描 → 添加扫描目录」进入，勾选若干
 *    文件夹后「立即扫描」（合并进当前扫描目录列表并执行一次扫描）。
 *
 * 浏览实现按平台分流：
 *  - Android：StoragePlugin（java.io.File 直读，可写探针 + 「所有文件访问」授权引导）；
 *  - iOS：Filesystem 插件 readdir（沙盒内无权限问题），音频计数逐目录懒加载。
 *
 * 列表行左侧为文件夹名 + 音频数「N首」，右侧始终是勾选框：多选模式勾选加入
 * 扫描集合，单选模式勾选即选定该文件夹为下载目录（先探针验证可写）；
 * 「Android」等系统目录与隐藏目录显示「已过滤」，不可进入也不可勾选。
 * 底部为文字操作：新建文件夹（创建并进入）+ 单选「选择此文件夹」/ 多选「立即扫描」。
 */

type IOPlatform = "android" | "ios";

interface IBrowseDir {
    name: string;
    /** 直接子级音频数；iOS 懒加载，未知时为 null */
    audioCount: number | null;
}

function fileUriToPath(uri?: string): string {
    if (!uri) {
        return "";
    }
    try {
        let p = uri.startsWith("file://") ? decodeURIComponent(uri.slice(7)) : uri;
        p = p.replace(/\/\.$/, "").replace(/\/+$/, "");
        return p;
    } catch {
        return "";
    }
}

function joinAbs(root: string, segs: string[]): string {
    return segs.length ? `${root}/${segs.join("/")}` : root;
}

/** 绝对路径 → 相对根的段数组；不在根下（如应用私有目录）返回 null */
function absToSegs(root: string, abs: string): string[] | null {
    if (!root || !abs) {
        return null;
    }
    if (abs === root) {
        return [];
    }
    if (!abs.startsWith(`${root}/`)) {
        return null;
    }
    return abs.slice(root.length + 1).split("/").filter(Boolean);
}

async function getRootPath(platform: IOPlatform): Promise<string> {
    if (platform === "android") {
        const res = await callNativeMethod("Storage", "getStorageRoot");
        return String(res?.path || "");
    }
    // iOS：EXTERNAL_STORAGE 目录别名即沙盒 Documents
    return fileUriToPath(
        (await callNativeMethod("Filesystem", "getUri", { path: ".", directory: "EXTERNAL_STORAGE" }))?.uri,
    );
}

async function listDirs(
    platform: IOPlatform,
    root: string,
    segs: string[],
): Promise<IBrowseDir[]> {
    if (platform === "android") {
        const res = await callNativeMethod("Storage", "listDirs", { path: joinAbs(root, segs) });
        return (Array.isArray(res?.dirs) ? res.dirs : []).map((d: any) => ({
            name: String(d?.name ?? ""),
            audioCount: typeof d?.audioCount === "number" ? d.audioCount : null,
        }));
    }
    const res = await callNativeMethod("Filesystem", "readdir", {
        path: segs.join("/") || ".",
        directory: "EXTERNAL_STORAGE",
    });
    const files: any[] = Array.isArray(res?.files) ? res.files : [];
    return files
        .filter(
            (f) =>
                f &&
                typeof f.name === "string" &&
                !f.name.startsWith(".") &&
                (f.type ? f.type === "directory" : !f.name.includes(".")),
        )
        .map((f) => ({ name: f.name, audioCount: null }));
}

/** iOS：单个文件夹的直接音频文件数（Filesystem readdir，懒加载） */
async function countDirIos(segs: string[], name: string): Promise<number> {
    const res = await callNativeMethod("Filesystem", "readdir", {
        path: [...segs, name].join("/"),
        directory: "EXTERNAL_STORAGE",
    });
    const files: any[] = Array.isArray(res?.files) ? res.files : [];
    return files.filter(
        (f) => f && f.type !== "directory" && AUDIO_EXT_RE.test(String(f.name ?? "")),
    ).length;
}

/** 单选模式回显：当前保存位置对应的绝对路径（system 返回空串） */
async function resolveCurrentAbs(platform: IOPlatform): Promise<string> {
    const target = getDownloadSaveTarget();
    if (target === "system") {
        return "";
    }
    if (target === "external") {
        return getDownloadExternalDir();
    }
    const subfolder = getDownloadSubfolder();
    if (platform === "android") {
        const dirs = await callNativeMethod("LocalMusic", "getDefaultDirs");
        const base = target === "documents" ? String(dirs.documents) : String(dirs.filesDir);
        return subfolder === "." ? base : `${base}/${subfolder}`;
    }
    return fileUriToPath(
        (await callNativeMethod("Filesystem", "getUri", {
            path: subfolder === "." ? "." : subfolder,
            directory: target === "data" ? "DATA" : "DOCUMENTS",
        }))?.uri,
    );
}

/** 系统目录 / 隐藏目录：展示「已过滤」，不可进入、不可勾选 */
function isFilteredDir(name: string): boolean {
    return name.startsWith(".") || name === "Android";
}

export default function FolderSelectPage({ mode }: { mode: "single" | "multi" }) {
    const platform = nativePlatform();
    const [rootPath, setRootPath] = useState("");
    const [segs, setSegs] = useState<string[]>([]);
    const [dirs, setDirs] = useState<IBrowseDir[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [counts, setCounts] = useState<Record<string, number>>({});
    const [busy, setBusy] = useState(false);
    /** Android「所有文件访问」授权状态（null = 未检查 / 非 Android） */
    const [allFiles, setAllFiles] = useState<boolean | null>(null);
    /** 单选：当前配置目录的绝对路径（"" = 系统下载目录） */
    const [currentAbs, setCurrentAbs] = useState("");
    const [currentIsSystem, setCurrentIsSystem] = useState(
        mode === "single" && getDownloadSaveTarget() === "system",
    );
    /** 多选：已勾选（绝对路径 → 相对段） */
    const [checked, setChecked] = useState<Map<string, string[]>>(new Map());

    const loadSeq = useRef(0);

    /* 初始化：解析存储根 + 回显当前状态 + Android 授权速查 */
    useEffect(() => {
        if (!platform) {
            return;
        }
        let alive = true;
        (async () => {
            try {
                const root = await getRootPath(platform);
                if (alive) {
                    setRootPath(root);
                }
                if (mode === "single") {
                    const abs = await resolveCurrentAbs(platform).catch(() => "");
                    if (alive) {
                        setCurrentAbs(abs);
                        setCurrentIsSystem(!abs);
                    }
                } else {
                    const effective = await getEffectiveScanDirs().catch(() => []);
                    const map = new Map<string, string[]>();
                    for (const d of effective) {
                        const s = absToSegs(root, d.path);
                        if (s) {
                            map.set(d.path, s);
                        }
                    }
                    if (alive) {
                        setChecked(map);
                    }
                }
            } catch (e: any) {
                console.warn("[folderSelect] 初始化失败", e);
                if (alive) {
                    setError(String(e?.message ?? e) || "无法访问存储目录");
                }
            }
        })();
        return () => {
            alive = false;
        };
    }, [platform, mode]);

    /* Android：「所有文件访问」授权速查；从系统设置返回（resume）后自动复查 */
    const refreshAccess = useRef(() => {});
    refreshAccess.current = () => {
        if (platform !== "android") {
            return;
        }
        callNativeMethod("Storage", "checkAccess")
            .then((res: any) => setAllFiles(!!res?.allFiles))
            .catch(() => setAllFiles(null));
    };
    useEffect(() => {
        refreshAccess.current();
        if (platform !== "android") {
            return;
        }
        return addNativeListener("App", "resume", () => refreshAccess.current());
    }, [platform]);

    /* 目录列表：进入 / 上级 / 切目录时重新读取 */
    useEffect(() => {
        if (!platform || !rootPath) {
            return;
        }
        const seq = ++loadSeq.current;
        setDirs(null);
        setError(null);
        listDirs(platform, rootPath, segs)
            .then((list) => {
                if (seq === loadSeq.current) {
                    setDirs(list);
                }
            })
            .catch((e: any) => {
                if (seq !== loadSeq.current) {
                    return;
                }
                console.warn("[folderSelect] listDirs 失败", e);
                setError(String(e?.message ?? e) || "读取失败");
                setDirs([]);
            });
    }, [platform, rootPath, segs]);

    /* iOS：音频计数逐目录懒加载（Android 由 listDirs 一次性带回） */
    useEffect(() => {
        if (platform !== "ios" || !dirs?.length) {
            return;
        }
        let alive = true;
        (async () => {
            for (const d of dirs) {
                if (!alive) {
                    return;
                }
                try {
                    const n = await countDirIos(segs, d.name);
                    if (alive) {
                        setCounts((prev) => ({ ...prev, [d.name]: n }));
                    }
                } catch {
                    // 计数失败就空着
                }
            }
        })();
        return () => {
            alive = false;
        };
    }, [platform, dirs, segs]);

    if (!platform) {
        return (
            <div className="page">
                <div className="sub-header">
                    <button className="icon-btn" onClick={() => goBack()}>
                        <IconBack size={22} />
                    </button>
                    <span className="sub-header-title">选择文件夹</span>
                </div>
                <div className="empty-tip">文件夹选择请在手机 App 中使用</div>
            </div>
        );
    }

    const goUp = () => {
        if (segs.length) {
            setSegs(segs.slice(0, -1));
        } else {
            goBack();
        }
    };

    const reload = () => setSegs([...segs]);

    const toggleCheck = (name: string) => {
        const abs = joinAbs(rootPath, [...segs, name]);
        setChecked((prev) => {
            const next = new Map(prev);
            if (next.has(abs)) {
                next.delete(abs);
            } else {
                next.set(abs, [...segs, name]);
            }
            return next;
        });
    };

    const pickSystem = () => {
        setDownloadSaveTarget("system");
        showToast("下载保存位置：系统下载目录");
        goBack();
    };

    /** 新建文件夹并进入（已存在时视为成功直接进入） */
    const newFolder = () => {
        openPrompt({
            title: segs.length ? `在「${segs[segs.length - 1]}」中新建文件夹` : "新建文件夹",
            placeholder: "文件夹名称",
            confirmText: "创建",
            onConfirm: (value) => {
                const clean = value.replace(/[/\\]/g, "").trim();
                if (!clean) {
                    showToast("文件夹名不能为空");
                    return;
                }
                const nextSegs = [...segs, clean];
                const req =
                    platform === "android"
                        ? callNativeMethod("Storage", "mkdir", {
                              path: joinAbs(rootPath, nextSegs),
                          })
                        : callNativeMethod("Filesystem", "mkdir", {
                              path: nextSegs.join("/"),
                              directory: "EXTERNAL_STORAGE",
                              recursive: true,
                          });
                req
                    .then(() => {
                        setSegs(nextSegs);
                        showToast(`已创建「${clean}」`);
                    })
                    .catch((e: any) => {
                        const msg = String(e?.message ?? e);
                        if (/exist/i.test(msg)) {
                            setSegs(nextSegs);
                            return;
                        }
                        console.warn("[folderSelect] mkdir 失败", e);
                        showToast(`创建失败：${msg || "未知错误"}`, 3200);
                    });
            },
        });
    };

    /** 多选：合并勾选目录进扫描列表并立即扫描 */
    const startScan = async () => {
        if (busy) {
            return;
        }
        if (!checked.size) {
            showToast("先勾选要扫描的文件夹");
            return;
        }
        setBusy(true);
        try {
            const granted = await requestAudioPermission();
            if (!granted) {
                showToast("未授予音频读取权限，部分文件夹可能扫不到", 3200);
            }
            const effective = await getEffectiveScanDirs();
            const merged = [...effective];
            for (const [abs, checkedSegs] of checked) {
                if (!merged.some((d) => d.path === abs)) {
                    merged.push(
                        platform === "ios"
                            ? { path: abs, directory: "DOCUMENTS", rel: checkedSegs.join("/") || "." }
                            : { path: abs },
                    );
                }
            }
            setCustomScanDirs(merged);
            const res = await scanLocalMusic();
            const parts = [`扫描完成：共 ${res.total} 首，新增 ${res.added} 首`];
            if (res.removed) {
                parts.push(`移除 ${res.removed} 首`);
            }
            if (res.skippedShort) {
                parts.push(`跳过 ${res.skippedShort} 个短音频`);
            }
            if (res.failedDirs.length) {
                parts.push(`${res.failedDirs.length} 个目录无法读取`);
            }
            showToast(parts.join("，"), 4200);
            goBack();
        } catch (e: any) {
            showToast(`扫描失败：${e?.message ?? e}`, 3600);
        } finally {
            setBusy(false);
        }
    };

    /** 单选：探针确认可写后写回保存位置设置（勾选框 / 底部按钮共用） */
    const pickSegs = async (targetSegs: string[]) => {
        if (busy) {
            return;
        }
        setBusy(true);
        try {
            const abs = joinAbs(rootPath, targetSegs);
            if (platform === "android") {
                const perm = await callNativeMethod("Storage", "requestWritePermission");
                if (!perm?.granted) {
                    if (perm?.needAllFiles) {
                        showToast("需要「所有文件访问」权限，请在系统设置中允许后重试", 3600);
                        callNativeMethod("Storage", "openAllFilesAccess").catch(() => {});
                    } else {
                        showToast("未授予存储写入权限", 3200);
                    }
                    return;
                }
                const probe = await callNativeMethod("Storage", "canWrite", { path: abs });
                if (!probe?.writable) {
                    showToast(`该文件夹不可写：${probe?.reason ?? "未知原因"}`, 3600);
                    return;
                }
                setDownloadSaveTarget("external");
                setDownloadExternalDir(abs);
            } else {
                // iOS：EXTERNAL_STORAGE 根即沙盒 Documents，落成 documents + 相对路径
                const probePath = `${targetSegs.length ? `${targetSegs.join("/")}/` : ""}.mf-write-probe`;
                try {
                    await callNativeMethod("Filesystem", "writeFile", {
                        path: probePath,
                        directory: "EXTERNAL_STORAGE",
                        data: "ok",
                        recursive: true,
                    });
                    callNativeMethod("Filesystem", "deleteFile", {
                        path: probePath,
                        directory: "EXTERNAL_STORAGE",
                    }).catch(() => undefined);
                } catch (e: any) {
                    showToast(`该文件夹不可写：${e?.message ?? "写入失败"}`, 3600);
                    return;
                }
                setDownloadSaveTarget("documents");
                setDownloadSubfolder(normalizeSubfolder(targetSegs.join("/") || "."));
            }
            showToast(`下载保存位置：${downloadSaveTargetLabel()}`);
            goBack();
        } finally {
            setBusy(false);
        }
    };

    const confirmPick = () => pickSegs(segs);

    /** 单选：勾选框直接选定该文件夹 */
    const pickCheck = (name: string) => {
        void pickSegs([...segs, name]);
    };

    const openAllFiles = () => {
        callNativeMethod("Storage", "openAllFilesAccess").catch(() => {});
    };

    const hereAbs = joinAbs(rootPath, segs);
    const currentHere = mode === "single" && !currentIsSystem && hereAbs === currentAbs;

    return (
        <div className="page fsp-page">
            <div className="sub-header fsp-header">
                <button className="icon-btn" onClick={goUp}>
                    <IconBack size={22} />
                </button>
                <div className="fsp-path">{rootPath ? `${hereAbs}/` : "存储目录"}</div>
            </div>

            {platform === "android" && allFiles === false && (
                <button className="fsp-banner" onClick={openAllFiles}>
                    需要「所有文件访问」权限才能浏览和保存到任意文件夹，点此去系统设置授权
                </button>
            )}

            <div className="fsp-scroll">
                {mode === "single" && (
                    <div className="fsp-row" onClick={pickSystem}>
                        <span className="fsp-row-icon">
                            <IconDownload size={20} />
                        </span>
                        <div className="fsp-row-info">
                            <div className="fsp-row-name">系统下载目录</div>
                            <div className="fsp-row-sub">走系统下载通道，位置由系统决定</div>
                        </div>
                        {currentIsSystem && (
                            <span className="fsp-check on">
                                <IconCheck size={14} />
                            </span>
                        )}
                    </div>
                )}

                {dirs === null && !error && <div className="fsp-state">正在读取…</div>}
                {error && (
                    <div className="fsp-state fsp-state-error">
                        <span>无法读取该目录：{error}</span>
                        <button className="settings-btn" onClick={reload}>
                            重试
                        </button>
                    </div>
                )}
                {dirs?.map((d) => {
                    const filtered = isFilteredDir(d.name);
                    const rowAbs = joinAbs(rootPath, [...segs, d.name]);
                    const count = d.audioCount ?? counts[d.name];
                    const isChecked = checked.has(rowAbs);
                    return (
                        <div
                            key={d.name}
                            className={`fsp-row ${filtered ? "filtered" : ""}`}
                            onClick={filtered ? undefined : () => setSegs([...segs, d.name])}
                        >
                            <span className="fsp-row-icon">
                                <IconFolder size={20} />
                            </span>
                            <div className="fsp-row-info">
                                <div className="fsp-row-name">{d.name}</div>
                                <div className="fsp-row-sub">
                                    {count === undefined || count === null ? "" : `${count}首`}
                                </div>
                            </div>
                            {filtered ? (
                                <span className="fsp-filtered">已过滤</span>
                            ) : mode === "multi" ? (
                                <span
                                    className={`fsp-check ${isChecked ? "on" : ""}`}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        toggleCheck(d.name);
                                    }}
                                >
                                    {isChecked && <IconCheck size={14} />}
                                </span>
                            ) : (
                                <span
                                    className={`fsp-check ${rowAbs === currentAbs ? "on" : ""}`}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        pickCheck(d.name);
                                    }}
                                >
                                    {rowAbs === currentAbs && <IconCheck size={14} />}
                                </span>
                            )}
                        </div>
                    );
                })}
                {dirs !== null && !error && !dirs.length && (
                    <div className="fsp-state">这里是空的</div>
                )}
            </div>

            <div className="fsp-footer">
                <button className="fsp-action" onClick={newFolder}>
                    <IconFolderPlus size={22} />
                    <span>新建文件夹</span>
                </button>
                {mode === "single" ? (
                    <button
                        className="fsp-action"
                        onClick={confirmPick}
                        disabled={busy}
                    >
                        <IconCheck size={22} />
                        <span>
                            {busy
                                ? "检查中…"
                                : currentHere
                                  ? "当前使用此文件夹"
                                  : "选择此文件夹"}
                        </span>
                    </button>
                ) : (
                    <button
                        className="fsp-action"
                        onClick={startScan}
                        disabled={busy}
                    >
                        <IconFolderSearch size={22} />
                        <span>{busy ? "扫描中…" : "立即扫描"}</span>
                    </button>
                )}
            </div>
        </div>
    );
}
