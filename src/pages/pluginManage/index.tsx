import { useEffect, useRef, useState } from "react";
import { goBack } from "@/core/router";
import { pluginHost, getPlugins, invalidatePluginCache, type SerializedPlugin } from "@/core/ipc";
import { openPrompt, showToast } from "@/core/uiAtoms";
import { setDefaultPluginHash, getGlobalSource, setGlobalSource, useDefaultPluginHash, AUTO_SOURCE } from "@/core/mediaSource";
import { useBackLayer } from "@/core/systemBack";
import { IconBack, IconLink, IconFileCode, IconRefresh, IconTrash, IconCheck, IconClose } from "@/components/base/Icons";

/**
 * 插件管理页：从链接/本地文件安装音源插件，启用/禁用、排序、用户变量、设为默认音源。
 * 插件格式与 MusicFree（移动端）/ MusicFreeDesktop 完全一致。
 */

/** 复制文本到剪贴板（详情面板里点击 hash / 链接触发） */
function copyText(text: string) {
    navigator.clipboard?.writeText(text).then(
        () => showToast("已复制"),
        () => showToast("复制失败"),
    );
}

/** 音源详情底部面板：展示插件元信息、支持的能力、用户变量 */
function PluginDetailSheet({ plugin, onClose }: { plugin: SerializedPlugin | null; onClose: () => void }) {
    useBackLayer(!!plugin, "plugin-detail", onClose);

    if (!plugin) {
        return null;
    }

    const vars = Array.isArray(plugin.userVariablesDef) && plugin.userVariablesDef.length
        ? plugin.userVariablesDef.map((def: any) => ({
              name: def.name ?? def.key,
              value: plugin.userVariables?.[def.key]?.trim(),
          }))
        : Object.entries(plugin.userVariables ?? {})
              .filter(([, v]) => v?.trim())
              .map(([k, v]) => ({ name: k, value: v.trim() }));

    return (
        <div className="sheet-mask" onClick={onClose}>
            <div className="add-sheet-panel plugin-detail-panel" onClick={(e) => e.stopPropagation()}>
                <div className="plugin-detail-head">
                    <div className="plugin-detail-title">
                        {plugin.name}
                        <span className="plugin-badge">v{plugin.version || "未知"}</span>
                        <span className={`plugin-badge ${plugin.state === "Mounted" ? "ok" : "err"}`}>
                            {plugin.state === "Mounted" ? "已挂载" : plugin.errorReason ?? "错误"}
                        </span>
                    </div>
                    <button className="icon-btn" onClick={onClose}>
                        <IconClose size={20} />
                    </button>
                </div>
                <div className="plugin-detail-body">
                    <div className="plugin-detail-row">
                        <span className="plugin-detail-label">作者</span>
                        <span className="plugin-detail-value">{plugin.author || "未知"}</span>
                    </div>
                    <div className="plugin-detail-row">
                        <span className="plugin-detail-label">平台标识</span>
                        <span className="plugin-detail-value plugin-detail-mono">{plugin.platform || "未知"}</span>
                    </div>
                    <div className="plugin-detail-row">
                        <span className="plugin-detail-label">运行状态</span>
                        <span className="plugin-detail-value">
                            {plugin.state === "Mounted" ? "已挂载，可正常使用" : `加载失败（${plugin.errorReason ?? "未知原因"}）`}
                        </span>
                    </div>
                    <div className="plugin-detail-row">
                        <span className="plugin-detail-label">启用状态</span>
                        <span className="plugin-detail-value">{plugin.enabled ? "已启用" : "已禁用"}</span>
                    </div>
                    <div className="plugin-detail-row">
                        <span className="plugin-detail-label">描述</span>
                        <span className="plugin-detail-value">{plugin.description || "暂无描述"}</span>
                    </div>
                    {plugin.srcUrl && (
                        <div className="plugin-detail-row">
                            <span className="plugin-detail-label">来源链接</span>
                            <span
                                className="plugin-detail-value copyable plugin-detail-mono"
                                onClick={() => copyText(plugin.srcUrl)}
                            >
                                {plugin.srcUrl}
                            </span>
                        </div>
                    )}
                    <div className="plugin-detail-row">
                        <span className="plugin-detail-label">插件指纹</span>
                        <span
                            className="plugin-detail-value copyable plugin-detail-mono"
                            onClick={() => copyText(plugin.hash)}
                        >
                            {plugin.hash.slice(0, 16)}…{plugin.hash.slice(-8)}
                        </span>
                    </div>

                    {Array.isArray(plugin.supportedMethods) && plugin.supportedMethods.length > 0 && (
                        <div className="plugin-detail-block">
                            <div className="plugin-detail-block-title">支持的能力</div>
                            <div className="plugin-detail-tags">
                                {plugin.supportedMethods.map((m) => (
                                    <span key={m} className="plugin-detail-tag">
                                        {m}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}

                    {vars.length > 0 && (
                        <div className="plugin-detail-block">
                            <div className="plugin-detail-block-title">用户变量</div>
                            {vars.map((v) => (
                                <div key={v.name} className="plugin-detail-var">
                                    <span className="plugin-detail-var-name">{v.name}</span>
                                    <span className="plugin-detail-var-value">{v.value || "未设置"}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

export default function PluginManagePage() {
    const [plugins, setPlugins] = useState<SerializedPlugin[]>([]);
    const [url, setUrl] = useState("");
    const [expanded, setExpanded] = useState<string | null>(null);
    const [detail, setDetail] = useState<SerializedPlugin | null>(null);
    const defaultHash = useDefaultPluginHash();
    const fileRef = useRef<HTMLInputElement | null>(null);

    const refresh = async () => {
        invalidatePluginCache();
        const list = await getPlugins(true);
        setPlugins([...list].sort((a, b) => a.order - b.order));
    };

    useEffect(() => {
        refresh();
    }, []);

    const installFromUrl = async () => {
        const trimmed = url.trim();
        if (!trimmed) {
            showToast("请输入插件链接");
            return;
        }
        try {
            const res = await pluginHost.installPluginFromUrl(trimmed);
            if (res.success) {
                showToast(`插件「${res.pluginName ?? ""}」安装成功`);
                setUrl("");
                refresh();
            } else {
                // 可能是聚合订阅源
                if (res.errorCode === "IS_PLUGIN_INDEX") {
                    const idxRes = await pluginHost.importPluginIndex(trimmed);
                    const ok = (idxRes as any).failed
                        ? (idxRes as any).failed.length === 0
                        : true;
                    showToast(
                        ok
                            ? `插件集导入成功（${(idxRes as any).installed ?? 0} 个插件）`
                            : "插件集部分导入失败",
                    );
                    refresh();
                    return;
                }
                showToast(res.message ?? "安装失败");
            }
        } catch (e: any) {
            showToast(e?.message ?? "安装失败");
        }
    };

    const installFromFile = async (file: File) => {
        try {
            const res = await pluginHost.installPluginFromLocalFile(file);
            showToast(
                res.success
                    ? `插件「${res.pluginName ?? ""}」安装成功`
                    : res.message ?? "安装失败",
            );
            if (res.success) {
                refresh();
            }
        } catch (e: any) {
            showToast(e?.message ?? "安装失败");
        }
    };

    const movePlugin = async (hash: string, dir: -1 | 1) => {
        const hashes = plugins.map((p) => p.hash);
        const idx = hashes.indexOf(hash);
        const target = idx + dir;
        if (target < 0 || target >= hashes.length) {
            return;
        }
        [hashes[idx], hashes[target]] = [hashes[target], hashes[idx]];
        pluginHost.setPluginOrder(hashes);
        await refresh();
    };

    return (
        <div className="page">
            <div className="sub-header">
                <button className="icon-btn" onClick={() => goBack()}>
                    <IconBack size={22} />
                </button>
                <span className="sub-header-title">插件管理</span>
                <button
                    className="icon-btn"
                    onClick={() => {
                        const link =
                            "https://github.com/maotoumao/MusicFreePlugins";
                        openPrompt({
                            title: "安装插件",
                            placeholder: `例如粘贴 ${link.slice(8, 40)}…`,
                            confirmText: "安装",
                            onConfirm: (value) => {
                                if (value.trim()) {
                                    setUrl(value.trim());
                                    setTimeout(() => installFromUrl(), 0);
                                }
                            },
                        });
                    }}
                >
                    <IconLink size={20} />
                </button>
            </div>

            <div className="plugin-install-row">
                <input
                    className="settings-input"
                    style={{ flex: 1, width: "auto" }}
                    placeholder="粘贴插件 .js 链接"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                />
                <button className="settings-btn primary" onClick={installFromUrl}>
                    安装
                </button>
                <button className="settings-btn" onClick={() => fileRef.current?.click()}>
                    <IconFileCode size={15} />
                </button>
                <input
                    ref={fileRef}
                    type="file"
                    accept=".js,.json,application/javascript"
                    style={{ display: "none" }}
                    onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) {
                            installFromFile(f);
                        }
                        e.target.value = "";
                    }}
                />
            </div>
            <div className="settings-tip" style={{ paddingTop: 4 }}>
                支持标准 MusicFree 音源插件（.js）或插件订阅集（.json）。安装后与桌面端互通。
            </div>

            {plugins.map((p, idx) => {
                const isDefault = defaultHash === p.hash;
                const expandedOpen = expanded === p.hash;
                return (
                    <div key={p.hash} className="plugin-card">
                        <div className="plugin-card-head" onClick={() => setExpanded(expandedOpen ? null : p.hash)}>
                            <div className="plugin-card-main">
                                <div className="plugin-card-name">
                                    {p.name}
                                    <span className="plugin-badge">{p.version || "未知版本"}</span>
                                    <span className={`plugin-badge ${p.state === "Mounted" ? "ok" : "err"}`}>
                                        {p.state === "Mounted" ? "已挂载" : p.errorReason ?? "错误"}
                                    </span>
                                    {isDefault && <span className="plugin-badge primary">默认音源</span>}
                                </div>
                                <div className="plugin-card-desc">
                                    {p.description || "暂无描述"}
                                    {p.author ? ` · ${p.author}` : ""}
                                </div>
                            </div>
                            <div
                                className={`plugin-switch ${p.enabled ? "on" : ""}`}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    pluginHost.setPluginEnabled(p.hash, !p.enabled);
                                    setTimeout(refresh, 60);
                                }}
                            />
                        </div>

                        {expandedOpen && (
                            <>
                                <div className="plugin-card-foot">
                                    <button className="pill" onClick={() => setDetail(p)}>
                                        详情
                                    </button>
                                    {p.srcUrl && (
                                        <button
                                            className="pill"
                                            onClick={async () => {
                                                showToast("正在更新…");
                                                const res = await pluginHost.installPluginFromUrl(p.srcUrl!);
                                                showToast(res.success ? "已是最新版本" : res.message ?? "更新失败");
                                                refresh();
                                            }}
                                        >
                                            <IconRefresh size={13} />
                                            更新
                                        </button>
                                    )}
                                    <button
                                        className="pill"
                                            onClick={() => {
                                                if (isDefault) {
                                                    setDefaultPluginHash(null);
                                                    showToast("已取消默认音源");
                                                } else {
                                                    setDefaultPluginHash(p.hash);
                                                    showToast(`已将「${p.name}」设为默认音源，全局音源已切换`);
                                                }
                                                refresh();
                                            }}
                                    >
                                        {isDefault ? <IconCheck size={13} /> : null}
                                        {isDefault ? "取消默认" : "设为默认"}
                                    </button>
                                    <button className="pill" onClick={() => movePlugin(p.hash, -1)} disabled={idx === 0}>
                                        上移
                                    </button>
                                    <button className="pill" onClick={() => movePlugin(p.hash, 1)} disabled={idx === plugins.length - 1}>
                                        下移
                                    </button>
                                    <button
                                        className="pill"
                                        style={{ color: "var(--primary-color)" }}
                                        onClick={async () => {
                                            await pluginHost.uninstallPlugin(p.hash);
                                            // 卸载的是默认音源 / 当前全局音源时同步清理
                                            if (getGlobalSource() === p.hash) {
                                                setGlobalSource(AUTO_SOURCE);
                                            }
                                            if (defaultHash === p.hash) {
                                                setDefaultPluginHash(null);
                                            }
                                            showToast(`已卸载「${p.name}」`);
                                            refresh();
                                        }}
                                    >
                                        <IconTrash size={13} />
                                        卸载
                                    </button>
                                </div>

                                {Array.isArray(p.userVariablesDef) && p.userVariablesDef.length > 0 && (
                                    <div className="plugin-vars">
                                        {p.userVariablesDef.map((def: any) => (
                                            <div key={def.key} className="plugin-var-row">
                                                <label title={def.hint ?? def.key}>{def.name ?? def.key}</label>
                                                <input
                                                    defaultValue={p.userVariables?.[def.key] ?? ""}
                                                    placeholder={def.hint ?? "请输入"}
                                                    onBlur={(e) => {
                                                        pluginHost.setUserVariables(p.hash, {
                                                            ...p.userVariables,
                                                            [def.key]: e.target.value.trim(),
                                                        });
                                                        showToast("已保存，下次调用生效");
                                                    }}
                                                />
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                );
            })}

            {!plugins.length && (
                <div className="empty-tip">
                    还没有安装插件
                    <br />
                    粘贴插件链接安装后即可搜歌、听歌
                </div>
            )}

            <PluginDetailSheet plugin={detail} onClose={() => setDetail(null)} />
        </div>
    );
}
