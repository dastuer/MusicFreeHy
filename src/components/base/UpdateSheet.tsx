import { useState } from "react";
import { useAtomValue } from "jotai";
import {
    closeUpdateSheet,
    showToast,
    updateSheetAtom,
    type IUpdateSheetState,
} from "@/core/uiAtoms";
import { useBackLayer } from "@/core/systemBack";
import {
    cancelUpdateDownload,
    dismissUpdateSheet,
    downloadUpdateApk,
    ignoreUpdateVersion,
    installUpdateApk,
    isUpdateDownloading,
} from "@/core/appUpdate";

/**
 * 发现新版本面板：更新日志 + 下载进度 + 拉起安装器。
 * 强制更新（minVersionCode 高于本机）时 mask、返回键、「忽略/稍后」全部不可用。
 * 面板关闭即整棵卸载，重开时状态自动回到「待下载」。
 */
export default function UpdateSheet() {
    const state = useAtomValue(updateSheetAtom);
    const open = !!state;
    const force = !!(
        state &&
        state.manifest.minVersionCode !== undefined &&
        state.manifest.minVersionCode > state.local.versionCode
    );

    // 系统返回先收起面板（强制更新时返回键不消费，面板常驻）
    useBackLayer(open && !force, "update-sheet", () => {
        void dismissUpdateSheet(isUpdateDownloading());
    });

    if (!state) {
        return null;
    }

    return (
        <div
            className="sheet-mask"
            onClick={() => {
                if (!force) {
                    void dismissUpdateSheet(isUpdateDownloading());
                }
            }}
        >
            <div className="update-panel" onClick={(e) => e.stopPropagation()}>
                <UpdateSheetBody state={state} force={force} />
            </div>
        </div>
    );
}

function UpdateSheetBody({
    state,
    force,
}: {
    state: IUpdateSheetState;
    force: boolean;
}) {
    const { manifest, local } = state;
    const [phase, setPhase] = useState<"idle" | "downloading" | "downloaded">("idle");
    const [progress, setProgress] = useState({ loaded: 0, total: 0 });
    const [apkPath, setApkPath] = useState<string | null>(null);
    const [needPermission, setNeedPermission] = useState(false);

    const startDownload = () => {
        setNeedPermission(false);
        setPhase("downloading");
        setProgress({ loaded: 0, total: 0 });
        downloadUpdateApk(manifest, (loaded, total) => setProgress({ loaded, total }))
            .then((path) => {
                setApkPath(path);
                setPhase("downloaded");
            })
            .catch((e: any) => {
                setPhase("idle");
                // 用户主动取消时原生 reject「下载已取消」，不作为失败打扰
                const msg = e?.message !== undefined ? String(e.message) : String(e ?? "未知错误");
                if (!msg.includes("取消")) {
                    showToast(`下载失败：${msg}`);
                }
            });
    };

    const cancelDownload = () => {
        setPhase("idle");
        void cancelUpdateDownload();
    };

    const install = async () => {
        if (!apkPath) {
            return;
        }
        try {
            const res = await installUpdateApk(apkPath);
            if (res?.needPermission) {
                setNeedPermission(true);
            }
        } catch (e: any) {
            showToast(`无法启动安装：${e?.message ?? e ?? "未知错误"}`);
        }
    };

    // 忽略此版本：静默检查不再提示；手动检查仍可弹出（用户主动点了就要给看）
    const ignore = () => {
        ignoreUpdateVersion(manifest);
        closeUpdateSheet();
    };

    const percent =
        progress.total > 0 ? Math.round((progress.loaded / progress.total) * 100) : null;

    return (
        <>
            <div className="update-panel-header">
                <span>发现新版本 v{manifest.versionName}</span>
                {manifest.publishedAt && (
                    <span className="update-panel-date">{manifest.publishedAt}</span>
                )}
            </div>
            <div className="update-panel-version">
                当前版本 v{local.versionName}
                {force && <span className="update-panel-force"> · 重要更新，需安装后继续使用</span>}
            </div>
            <div className="update-panel-log">
                {manifest.changelog || "暂无更新说明"}
            </div>
            {phase === "downloading" && (
                <div className="update-panel-progress">
                    <div className="dl-bar-track">
                        <div
                            className="dl-bar-fill"
                            style={{ width: `${percent ?? 0}%` }}
                        />
                    </div>
                    <span className="update-panel-progress-text">
                        {percent !== null ? `${percent}% · ` : ""}
                        {fmtMB(progress.loaded)}
                        {progress.total > 0 ? ` / ${fmtMB(progress.total)} MB` : " MB"}
                    </span>
                </div>
            )}
            {needPermission && (
                <div className="update-panel-tip">
                    请在系统设置中允许「安装未知应用」，返回后再次点击「立即安装」
                </div>
            )}
            <div className="update-panel-actions">
                {phase === "idle" && (
                    <>
                        {!force && (
                            <button className="pill" onClick={ignore}>
                                忽略此版本
                            </button>
                        )}
                        <button className="pill primary" onClick={startDownload}>
                            下载更新
                        </button>
                    </>
                )}
                {phase === "downloading" && (
                    <>
                        {!force && (
                            <button className="pill" onClick={() => void dismissUpdateSheet(true)}>
                                稍后再说
                            </button>
                        )}
                        <button className="pill primary" onClick={cancelDownload}>
                            取消下载
                        </button>
                    </>
                )}
                {phase === "downloaded" && (
                    <>
                        {!force && (
                            <button className="pill" onClick={() => void dismissUpdateSheet(false)}>
                                稍后再说
                            </button>
                        )}
                        <button className="pill primary" onClick={() => void install()}>
                            立即安装
                        </button>
                    </>
                )}
            </div>
        </>
    );
}

/** 字节 → MB 文本（一位小数） */
function fmtMB(bytes: number): string {
    return (bytes / 1024 / 1024).toFixed(1);
}
