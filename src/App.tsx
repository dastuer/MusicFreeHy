import { useEffect } from "react";
import { useCurrentRoute, useIsTabRoot } from "@/core/router";
import { TrackPlayerSingleton, TrackPlayerEvents } from "@/core/trackPlayer";
import type { IPlayFailurePayload } from "@/core/trackPlayer";
import { pluginHost } from "@/core/ipc";
import { useThemeSetup } from "@/core/theme";
import { ensureLikesSheet } from "@/core/musicSheet";
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
import PluginManagePage from "@/pages/pluginManage";
import SettingsPage from "@/pages/settings";
import SettingsBackupPage from "@/pages/settings/backup";
import SettingsWebdavPage from "@/pages/settings/webdav";
import SettingsProxyPage from "@/pages/settings/proxy";

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
        default:
            return <HomePage />;
    }
}

export default function App() {
    useThemeSetup();
    const route = useCurrentRoute();
    const isTabRoot = useIsTabRoot();
    useEffect(() => {
        // 初始化：插件宿主、播放器、喜欢的音乐歌单
        ensureLikesSheet();
        pluginHost.setup().catch((e: any) => console.warn("[app] 插件宿主初始化失败", e));
        TrackPlayerSingleton.setup();
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
                <div className="page-swap" key={route.path}>
                    {renderPage(route.path, route.params)}
                </div>
                <MiniPlayer />
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
