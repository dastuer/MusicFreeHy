import { useEffect, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { goBack, navigate } from "@/core/router";
import { useThemeSetting, setTheme } from "@/core/theme";
import { getQuality, setQuality, getAllowCoPlay, setAllowCoPlay } from "@/core/appConfig";
import { getDownloadSaveTarget, downloadSaveTargetLabel } from "@/core/musicDownload";
import { APP_VERSION } from "@/core/backup";
import { setDefaultQuality, applyCoPlaySessionType } from "@/core/trackPlayer";
import { getProxyBase } from "@/core/net";
import { isNative } from "@/core/native";
import {
    isAndroidNative,
    isBatteryOptimizationIgnored,
    requestIgnoreBatteryOptimizations,
} from "@/core/mediaNotification";
import {
    AUDIO_CACHE_LIMIT_OPTIONS,
    audioCacheVersionAtom,
    clearAudioCache,
    enforceAudioCacheLimit,
    formatAudioCacheSize,
    getAudioCacheLimitLabel,
    getAudioCacheLimitMB,
    getAudioCacheStats,
    setAudioCacheLimitMB,
} from "@/core/audioCache";
import { showToast, openPrompt, openMusicActions, openSingleSelect, lyricTranslationAtom, setLyricTranslation } from "@/core/uiAtoms";
import { IconBack } from "@/components/base/Icons";

const THEME_OPTIONS = [
    { value: "light", label: "浅色" },
    { value: "dark", label: "深色" },
    { value: "auto", label: "跟随系统" },
];

const QUALITY_OPTIONS: { key: IMusic.IQualityKey; label: string }[] = [
    { key: "low", label: "流畅" },
    { key: "standard", label: "标准" },
    { key: "high", label: "极高" },
    { key: "super", label: "无损" },
];

/**
 * 设置页（一级）：只放简单开关，复杂配置（备份 / WebDAV / 代理）下沉二级页。
 * 页面在返回时会重挂载，localStorage 类取值无需订阅即可保持最新。
 */export default function SettingsPage() {
    const theme = useThemeSetting();
    const [quality, setQualityState] = useState(getQuality());
    const showTranslation = useAtomValue(lyricTranslationAtom);
    const [rememberProgress, setRememberProgress] = useState(
        localStorage.getItem("rememberProgress") !== "false",
    );
    const [allowCoPlay, setAllowCoPlayState] = useState(getAllowCoPlay());
    const [cacheLimit, setCacheLimitState] = useState(getAudioCacheLimitMB());
    // 缓存写入 / 清理后版本号自增，占用展示跟着刷新
    const cacheVersion = useAtomValue(audioCacheVersionAtom);
    const cacheStats = useMemo(() => getAudioCacheStats(), [cacheVersion]);
    // 电池优化白名单状态（仅安卓）：从系统弹窗回来时靠 visibilitychange 刷新
    const [batteryIgnored, setBatteryIgnored] = useState<boolean | null>(null);
    useEffect(() => {
        if (!isAndroidNative()) {
            return undefined;
        }
        let alive = true;
        const refresh = () =>
            isBatteryOptimizationIgnored().then((v) => {
                if (alive) {
                    setBatteryIgnored(v ?? null);
                }
            });
        refresh();
        document.addEventListener("visibilitychange", refresh);
        return () => {
            alive = false;
            document.removeEventListener("visibilitychange", refresh);
        };
    }, []);
    const proxy = getProxyBase();    const themeLabel =
        THEME_OPTIONS.find((t) => t.value === theme)?.label ?? "跟随系统";
    const qualityLabel =
        QUALITY_OPTIONS.find((q) => q.key === quality)?.label ?? "标准";

    const pickTheme = () =>
        openSingleSelect({
            title: "主题",
            options: THEME_OPTIONS,
            value: theme,
            onSelect: (v) => setTheme(v as "light" | "dark" | "auto"),
        });

    const pickQuality = () =>
        openSingleSelect({
            title: "默认音质",
            options: QUALITY_OPTIONS.map((q) => ({ value: q.key, label: q.label })),
            value: quality,
            onSelect: (v) => {
                setQualityState(v as IMusic.IQualityKey);
                setQuality(v as IMusic.IQualityKey);
                setDefaultQuality(v as IMusic.IQualityKey);
                showToast(
                    `默认音质：${QUALITY_OPTIONS.find((q) => q.key === v)?.label}`,
                );
            },
        });

    const pickCacheLimit = () =>
        openSingleSelect({
            options: AUDIO_CACHE_LIMIT_OPTIONS,
            value: String(cacheLimit),
            onSelect: (v) => {
                const mb = Number(v);
                setCacheLimitState(mb);
                setAudioCacheLimitMB(mb);
                void enforceAudioCacheLimit();
                showToast(`缓存上限：${getAudioCacheLimitLabel(mb)}`);
            },
        });

    const clearCache = () =>
        openMusicActions({
            musicItem: {} as any,
            title: "清理播放缓存",
            subtitle: cacheStats.count
                ? `将删除 ${cacheStats.count} 首歌的缓存（${formatAudioCacheSize(
                      cacheStats.size,
                  )}），不影响已下载的音乐`
                : "当前没有已缓存的歌曲",
            actions: [
                {
                    label: "清理",
                    danger: true,
                    onClick: () => {
                        if (!cacheStats.count) {
                            showToast("当前没有已缓存的歌曲");
                            return;
                        }
                        void clearAudioCache().then((r) =>
                            showToast(
                                `已清理 ${r.removed} 首歌的缓存，释放 ${formatAudioCacheSize(r.sizeFreed)}`,
                            ),
                        );
                    },
                },
            ],
        });

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
                <div className="settings-row" onClick={pickTheme}>
                    <span className="settings-row-label">主题</span>
                    <span className="settings-value">{themeLabel}</span>
                    <span className="settings-value">›</span>
                </div>
            </div>

            <div className="settings-group">
                <div className="settings-group-title">播放</div>
                <div className="settings-row" onClick={pickQuality}>
                    <span className="settings-row-label">默认音质</span>
                    <span className="settings-value">{qualityLabel}</span>
                    <span className="settings-value">›</span>
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
                    <span className="settings-row-label">记忆播放进度</span>
                    <div className={`plugin-switch ${rememberProgress ? "on" : ""}`} />
                </div>
                <div
                    className="settings-row"
                    onClick={() => {
                        const next = !showTranslation;
                        setLyricTranslation(next);
                        showToast(next ? "歌词将同时显示翻译" : "已关闭歌词翻译");
                    }}
                >
                    <span className="settings-row-label">歌词显示翻译</span>
                    <div className={`plugin-switch ${showTranslation ? "on" : ""}`} />
                </div>
                <div
                    className="settings-row"
                    onClick={() => {
                        const next = !allowCoPlay;
                        setAllowCoPlayState(next);
                        setAllowCoPlay(next);
                        applyCoPlaySessionType();
                        showToast(next ? "已允许与其他应用同时播放" : "已恢复独占播放");
                    }}
                >
                    <span className="settings-row-label">允许与其他应用同时播放</span>
                    <div className={`plugin-switch ${allowCoPlay ? "on" : ""}`} />
                </div>
                {isAndroidNative() && (
                    <div
                        className="settings-row"
                        onClick={() => {
                            if (batteryIgnored) {
                                showToast("已忽略电池优化，后台播放更稳定");
                                return;
                            }
                            void requestIgnoreBatteryOptimizations().then(() =>
                                isBatteryOptimizationIgnored().then((v) =>
                                    setBatteryIgnored(v ?? null),
                                ),
                            );
                        }}
                    >
                        <span className="settings-row-label">后台播放保活</span>
                        <span className="settings-value">
                            {batteryIgnored === null ? "" : batteryIgnored ? "已开启" : "未开启"}
                        </span>
                        <span className="settings-value">›</span>
                    </div>
                )}
            </div>

            <div className="settings-group">
                <div className="settings-group-title">缓存</div>
                <div className="settings-row" onClick={pickCacheLimit}>
                    <span className="settings-row-label">缓存上限</span>
                    <span className="settings-value">{getAudioCacheLimitLabel(cacheLimit)}</span>
                    <span className="settings-value">›</span>
                </div>
                <div className="settings-row" onClick={clearCache}>
                    <span className="settings-row-label">清理缓存</span>
                    <span className="settings-value">
                        {cacheStats.count
                            ? `${cacheStats.count} 首 · ${formatAudioCacheSize(cacheStats.size)}`
                            : "无缓存"}
                    </span>
                    <span className="settings-value">›</span>
                </div>
            </div>

            {isNative() && (
                <div className="settings-group">
                    <div className="settings-group-title">下载</div>
                    <div
                        className="settings-row"
                        onClick={() => navigate("folderSelect", { mode: "single" })}
                    >
                        <span className="settings-row-label">保存位置</span>
                        <span className="settings-value ellipsis">
                            {downloadSaveTargetLabel(getDownloadSaveTarget())}
                        </span>
                        <span className="settings-value">›</span>
                    </div>
                </div>
            )}

            {!isNative() && (
                <div className="settings-group">
                    <div className="settings-group-title">网络</div>
                    <div className="settings-row" onClick={() => navigate("settingsProxy")}>
                        <span className="settings-row-label">伴生代理</span>
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
