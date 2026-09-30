import { useAtomValue, useSetAtom } from "jotai";
import Cover from "@/components/base/Cover";
import Spinner from "@/components/base/Spinner";
import { IconPause, IconPlay, IconQueue } from "@/components/base/Icons";
import {
    TrackPlayerSingleton,
    useCurrentMusic,
    useMusicState,
} from "@/core/trackPlayer";
import { nowPlayingOpenAtom, queueOpenAtom } from "@/core/uiAtoms";

/** 底部迷你播放条：点击呼出播放页，右侧播放/暂停与队列 */
export default function MiniPlayer() {
    const currentMusic = useCurrentMusic();
    const musicState = useMusicState();
    const setNowPlayingOpen = useSetAtom(nowPlayingOpenAtom);
    const setQueueOpen = useSetAtom(queueOpenAtom);

    if (!currentMusic) {
        return null;
    }
    const playing = musicState === "playing";
    const coverSpinning = playing || musicState === "loading";
    const spinning = musicState !== "stopped";

    return (
        <div className={`mini-player ${spinning ? "" : "paused"}`}>
            <div
                onClick={() => setNowPlayingOpen(true)}
                style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}
            >
                <Cover
                    src={currentMusic.artwork}
                    size={44}
                    radius={22}
                    className={coverSpinning ? "mini-spin" : ""}
                />
                <div className="mini-info">
                    <div className="mini-title">{currentMusic.title}</div>
                    <div className="mini-artist">
                        {currentMusic.artist}
                        {musicState === "loading" ? " · 加载中…" : ""}
                    </div>
                </div>
            </div>
            <button
                className="mini-btn mini-play-btn"
                onClick={() => TrackPlayerSingleton.togglePlay()}
            >
                {musicState === "loading" ? (
                    <Spinner size={19} />
                ) : playing ? (
                    <IconPause size={19} />
                ) : (
                    <IconPlay size={19} />
                )}
            </button>
            <button className="mini-btn" onClick={() => setQueueOpen(true)}>
                <IconQueue size={20} />
            </button>
        </div>
    );
}
