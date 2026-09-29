import { useState } from "react";
import { goBack, navigate } from "@/core/router";
import { useThemeSetting, setTheme } from "@/core/theme";
import { getQuality, setQuality } from "@/core/appConfig";
import { APP_VERSION } from "@/core/backup";
import { getWebdavConfig, getWebdavLastAt } from "@/core/dav";
import { setDefaultQuality } from "@/core/trackPlayer";
import { getProxyBase } from "@/core/net";
import { isNative } from "@/core/native";
import { showToast, openPrompt, openMusicActions } from "@/core/uiAtoms";
import { IconBack } from "@/components/base/Icons";

/**
 * 设置页（一级）：只放简单开关，复杂配置（备份 / WebDAV / 代理）下沉二级页。
 * 页面在返回时会重挂载，localStorage 类取值无需订阅即可保持最新。
 */
export default function SettingsPage() {
    const theme = useThemeSetting();
    const [quality, setQualityState] = useState(getQuality());
    const [rememberProgress, setRememberProgress] = useState(
        localStorage.getItem("rememberProgress") !== "false",
    );
    const webdav = getWebdavConfig();
    const webdavConfigured = Boolean(webdav.url || webdav.username);
    const webdavLastUp = getWebdavLastAt("upload");
    const proxy = getProxyBase();

    const qualityOptions: { key: IMusic.IQualityKey; label: string }[] = [
        { key: "low", label: "流畅" },
        { key: "standard", label: "标准" },
        { key: "high", label: "极高" },
        { key: "super", label: "无损" },
    ];

    return (
        <div className="page">
            <div className="sub-header">
                <button className="icon-btn" onClick={() => goBack()}>
                    <IconBack size={22} />
                </button>
                <span className="sub-header-title">设置</span>
                <span style={{ width: 44 }} />
            </div>

            <div className="settings-group">
                <div className="settings-group-title">外观</div>
                <div className="settings-row">
                    <span className="settings-row-label">主题</span>
                    <div className="seg">
                        {(["light", "dark", "auto"] as const).map((t) => (
                            <span
                                key={t}
                                className={`seg-item ${theme === t ? "active" : ""}`}
                                onClick={() => setTheme(t)}
                            >
                                {t === "light" ? "浅色" : t === "dark" ? "深色" : "跟随系统"}
                            </span>
                        ))}
                    </div>
                </div>
            </div>

            <div className="settings-group">
                <div className="settings-group-title">播放</div>
                <div className="settings-row">
                    <span className="settings-row-label">默认音质</span>
                    <div className="seg">
                        {qualityOptions.map((q) => (
                            <span
                                key={q.key}
                                className={`seg-item ${quality === q.key ? "active" : ""}`}
                                onClick={() => {
                                    setQualityState(q.key);
                                    setQuality(q.key);
                                    setDefaultQuality(q.key);
                                    showToast(`默认音质：${q.label}`);
                                }}
                            >
                                {q.label}
                            </span>
                        ))}
                    </div>
                </div>
                <div
                    className="settings-row"
                    onClick={() => {
                        const next = !rememberProgress;
                        setRememberProgress(next);
                        localStorage.setItem("rememberProgress", String(next));
                        showToast(next ? "已记忆播放进度" : "已关闭进度记忆");
                    }}
                >
                    <span className="settings-row-label">
                        记忆播放进度
                        <div className="settings-row-desc">再次进入歌曲时从上次位置继续播放</div>
                    </span>
                    <div className={`plugin-switch ${rememberProgress ? "on" : ""}`} />
                </div>
            </div>

            <div className="settings-group">
                <div className="settings-group-title">数据与备份</div>
                <div className="settings-row" onClick={() => navigate("settingsBackup")}>
                    <span className="settings-row-label">
                        备份与恢复
                        <div className="settings-row-desc">导出 / 恢复本地备份，与桌面端互通</div>
                    </span>
                    <span className="settings-value">›</span>
                </div>
                <div className="settings-row" onClick={() => navigate("settingsWebdav")}>
                    <span className="settings-row-label">
                        WebDAV 云备份
                        <div className="settings-row-desc">与桌面端同账号互传</div>
                    </span>
                    <span className="settings-value">
                        {webdavConfigured
                            ? webdavLastUp
                                ? `已配置 · 上次备份 ${new Date(webdavLastUp).toLocaleDateString()}`
                                : "已配置"
                            : "未配置"}
                    </span>
                    <span className="settings-value">›</span>
                </div>
            </div>

            {!isNative() && (
                <div className="settings-group">
                    <div className="settings-group-title">网络</div>
                    <div className="settings-row" onClick={() => navigate("settingsProxy")}>
                        <span className="settings-row-label">
                            伴生代理
                            <div className="settings-row-desc">解决跨域与 WebDAV 备份，App 无需</div>
                        </span>
                        <span className="settings-value">{proxy ? "已设置" : "默认"}</span>
                        <span className="settings-value">›</span>
                    </div>
                </div>
            )}

            <div className="settings-group">
                <div className="settings-group-title">关于</div>
                <div
                    className="settings-row"
                    onClick={() =>
                        openPrompt({
                            title: "MusicFree 手机版",
                            defaultValue: "",
                            confirmText: "知道了",
                            onConfirm: () => undefined,
                        })
                    }
                >
                    <span className="settings-row-label">版本</span>
                    <span className="settings-value">{APP_VERSION}</span>
                </div>
                <div
                    className="settings-row"
                    onClick={() =>
                        openMusicActions({
                            musicItem: {} as any,
                            title: "MusicFree 手机版",
                            subtitle: "核心功能与 MusicFreeDesktop 对齐，插件/歌单/备份三端互通",
                            actions: [
                                {
                                    label: "好的",
                                    onClick: () => undefined,
                                },
                            ],
                        })
                    }
                >
                    <span className="settings-row-label">关于本项目</span>
                    <span className="settings-value">›</span>
                </div>
            </div>
        </div>
    );
}
