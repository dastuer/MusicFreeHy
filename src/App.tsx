import { useEffect } from "react";
import { useAtomValue } from "jotai";
import { useCurrentRoute, useIsTabRoot } from "@/core/router";
import { sourceSelectOpenAtom } from "@/core/uiAtoms";
import { TrackPlayerSingleton, TrackPlayerEvents } from "@/core/trackPlayer";
import type { IPlayFailurePayload } from "@/core/trackPlayer";
import { pluginHost } from "@/core/ipc";
import { setupMediaNotification } from "@/core/mediaNotification";
import { useThemeSetup } from "@/core/theme";
import { ensureLikesSheet } from "@/core/musicSheet";
import { resumeSavedMatchTask, getLocalMusicCount } from "@/core/localMusic";
import { showToast } from "@/core/uiAtoms";
import TabBar from "@/components/layout/TabBar";
import AppDrawer from "@/components/layout/AppDrawer";
import MiniPlayer from "@/components/layout/MiniPlayer";
import NowPlaying from "@/components/layout/NowPlaying";
import PlayQueuePanel from "@/components/layout/PlayQueuePanel";
import ToastHost from "@/components/base/ToastHost";
import MusicActionSheet from "@/components/base/MusicActionSheet";
import AddToSheetPanel from "@/components/base/AddToSheetPanel";
import SourceSelectSheet from "@/components/base/SourceSelectSheet";
import SingleSelectSheet from "@/components/base/SingleSelectSheet";
import PromptDialog from "@/components/base/PromptDialog";
import HomePage from "@/pages/home";
import MyMusicPage from "@/pages/myMusic";
import SearchPage from "@/pages/search";
import SheetDetailPage from "@/pages/sheetDetail";
import TopListPage from "@/pages/topList";
import TopListDetailPage from "@/pages/topListDetail";
import AlbumDetailPage from "@/pages/albumDetail";
import ArtistDetailPage from "@/pages/artistDetail";
import HistoryPage from "@/pages/history";
import DownloadsPage from "@/pages/downloads";
import LocalMusicPage from "@/pages/localMusic";
import PluginManagePage from "@/pages/pluginManage";
import SettingsPage from "@/pages/settings";
import SettingsBackupPage from "@/pages/settings/backup";
import SettingsWebdavPage from "@/pages/settings/webdav";
import SettingsProxyPage from "@/pages/settings/proxy";
import FolderSelectPage from "@/pages/folderSelect";

function renderPage(path: string, params: Record<string, any>) {
    switch (path) {
        case "home":
            return <HomePage />;
        case "myMusic":
            return <MyMusicPage />;
        case "search":
            return <SearchPage key={`search:${params.keyword ?? ""}`} />;
        case "sheetDetail":
            return (
                <SheetDetailPage
                    key={`sheet:${params.userSheetId ?? `${params.sheetItem?.platform}-${params.sheetItem?.id}`}`}
                />
            );
        case "topList":
            return <TopListPage />;
        case "topListDetail":
            return (
                <TopListDetailPage
                    key={`toplist:${params.topListItem?.platform}-${params.topListItem?.id}`}
                />
            );
        case "albumDetail":
            return (
                <AlbumDetailPage key={`album:${params.albumItem?.platform}-${params.albumItem?.id}`} />
            );
        case "artistDetail":
            return (
                <ArtistDetailPage key={`artist:${params.artistItem?.platform}-${params.artistItem?.id}`} />
            );
        case "history":
            return <HistoryPage />;
        case "downloads":
            return <DownloadsPage />;
        case "localMusic":
            return <LocalMusicPage />;
        case "pluginManage":
            return <PluginManagePage />;
        case "settings":
            return <SettingsPage />;
        case "settingsBackup":
            return <SettingsBackupPage />;
        case "settingsWebdav":
            return <SettingsWebdavPage />;
        case "settingsProxy":
            return <SettingsProxyPage />;
        case "folderSelect":
            return (
                <FolderSelectPage
                    key={`folderSelect:${params.mode ?? "single"}`}
                    mode={params.mode === "multi" ? "multi" : "single"}
                />
            );
        default:
            return <HomePage />;
    }
}

export default function App() {
    useThemeSetup();
    const route = useCurrentRoute();
    const isTabRoot = useIsTabRoot();
    const sourceSelectOpen = useAtomValue(sourceSelectOpenAtom);
    // 设置类页面（含音源设置面板）与文件夹选择页不展示底部播放条，聚焦配置操作
    const hideMiniPlayer =
        sourceSelectOpen ||
        route.path === "settings" ||
        route.path === "settingsBackup" ||
        route.path === "settingsWebdav" ||
        route.path === "settingsProxy" ||
        route.path === "folderSelect";
    useEffect(() => {
        // 初始化：插件宿主、播放器、喜欢的音乐歌单
        ensureLikesSheet();
        // 预热本地曲库缓存（ensureLikesSheet 已顺带预热歌单缓存）：
        // 把首次进入本地音乐页的全量 JSON.parse 挪到启动空闲期
        const warmupLibrary = () => getLocalMusicCount();
        if (typeof (window as any).requestIdleCallback === "function") {
            (window as any).requestIdleCallback(warmupLibrary);
        } else {
            setTimeout(warmupLibrary, 1200);
        }
        pluginHost.setup().catch((e: any) => console.warn("[app] 插件宿主初始化失败", e));
        TrackPlayerSingleton.setup();
        // 系统媒体通知（Android 下拉栏媒体卡片；仅原生环境生效）
        setupMediaNotification();
        // 上次没跑完的本地音乐匹配任务（应用退出即中断）：启动时自动续跑
        void resumeSavedMatchTask().catch((e: any) =>
            console.warn("[app] 恢复本地匹配任务失败", e),
        );
        // 播放失败不再静默：缺插件 / 链接失效 / 跨域拦截都直接告诉用户
        const onPlayFailed = ({ musicItem, reason, willSkip, downgradedTo }: IPlayFailurePayload) => {
            if (downgradedTo) {
                // 音质降级重试是过程性的，不弹提示
                return;
            }
            showToast(
                `无法播放《${musicItem.title}》：${reason}${willSkip ? "，将自动尝试下一首" : ""}`,
                3200,
            );
        };
        TrackPlayerSingleton.on(TrackPlayerEvents.PlayFailed, onPlayFailed);
        return () => {
            TrackPlayerSingleton.off(TrackPlayerEvents.PlayFailed, onPlayFailed);
        };
    }, []);

    // 系统返回（Android 返回键 / iOS 侧滑 / 浏览器后退）由 core/systemBack.ts 统一接管

    return (
        <div className="app-root">
            <div className="phone-frame">
                <div className="page-swap">
                    {/* 发现页常驻缓存：跳转任何页面都保留推荐/歌单/排行榜的数据与滚动位置 */}
                    <div
                        className="page-keepalive"
                        style={route.path === "home" ? undefined : { display: "none" }}
                    >
                        <HomePage />
                    </div>
                    {route.path !== "home" && (
                        <div className="page-swap-layer" key={route.path}>
                            {renderPage(route.path, route.params)}
                        </div>
                    )}
                </div>
                {!hideMiniPlayer && <MiniPlayer />}
                {/* Tab 栏自带 safe-bottom 内边距；播放条单独贴底时给安卓手势条 / iOS
                    Home 指示条留出空间 */}
                {isTabRoot ? <TabBar /> : <div className="safe-bottom-spacer" />}
            </div>
            <AppDrawer />
            <NowPlaying />
            <PlayQueuePanel />
            <MusicActionSheet />
            <AddToSheetPanel />
            <SourceSelectSheet />
            <SingleSelectSheet />
            <PromptDialog />
            <ToastHost />
        </div>
    );
}
