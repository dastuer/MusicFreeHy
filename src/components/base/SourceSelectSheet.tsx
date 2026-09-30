import { useAtomValue } from "jotai";
import { sourceSelectOpenAtom, closeSourceSelect } from "@/core/uiAtoms";
import { navigate } from "@/core/router";
import {
    useGlobalSource,
    useUsablePlugins,
    useDefaultPluginHash,
    setGlobalSource,
    AUTO_SOURCE,
} from "@/core/mediaSource";
import { useBackLayer } from "@/core/systemBack";
import { IconCheck, IconPuzzle } from "./Icons";

/**
 * 音源设置底部面板：「我的 → 音源设置」与首页侧边栏统一入口。
 * 点行切换全局音源，所有页面立即生效；
 * 默认音源（冷启动时优先使用，失败自动降级）在「插件管理」里设置。
 */
export default function SourceSelectSheet() {
    const open = useAtomValue(sourceSelectOpenAtom);
    const current = useGlobalSource();
    const plugins = useUsablePlugins();
    const defaultHash = useDefaultPluginHash();
    const defaultPlugin = defaultHash
        ? plugins.find((p) => p.hash === defaultHash)
        : null;
    const autoSub = defaultPlugin
        ? `优先使用「${defaultPlugin.name}」，失败自动切换`
        : defaultHash
          ? "默认音源已不可用，将按插件顺序自动尝试"
          : "未设置默认音源，将按插件顺序自动尝试";

    // 系统返回先收起面板
    useBackLayer(open, "source-select", closeSourceSelect);

    if (!open) {
        return null;
    }

    return (
        <div className="sheet-mask" onClick={() => closeSourceSelect()}>
            <div className="add-sheet-panel" onClick={(e) => e.stopPropagation()}>
                <div className="add-sheet-header">音源设置</div>
                <div className="add-sheet-list">
                    <div
                        className="add-sheet-row"
                        onClick={() => setGlobalSource(AUTO_SOURCE)}
                    >
                        <div className="add-sheet-row-info">
                            <div className="add-sheet-row-title">跟随默认音源</div>
                            <div className="add-sheet-row-sub">{autoSub}</div>
                        </div>
                        {current === AUTO_SOURCE && (
                            <span className="source-select-check">
                                <IconCheck size={17} />
                            </span>
                        )}
                    </div>
                    {plugins.map((p) => (
                        <div
                            key={p.hash}
                            className="add-sheet-row"
                            onClick={() => setGlobalSource(p.hash)}
                        >
                            <div className="add-sheet-row-info">
                                <div className="add-sheet-row-title">
                                    {p.name}
                                    {defaultHash === p.hash && (
                                        <span className="plugin-badge ok">默认</span>
                                    )}
                                </div>
                            </div>
                            {current === p.hash && (
                                <span className="source-select-check">
                                    <IconCheck size={17} />
                                </span>
                            )}
                        </div>
                    ))}
                    {!plugins.length && (
                        <div className="source-select-empty">
                            还没有可用音源，先到「插件管理」安装插件
                        </div>
                    )}
                </div>
                <button
                    className="add-sheet-new"
                    onClick={() => {
                        closeSourceSelect();
                        navigate("pluginManage");
                    }}
                >
                    <IconPuzzle size={18} />
                    <span>前往插件管理</span>
                </button>
            </div>
        </div>
    );
}
