import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
    TrackPlayerSingleton,
    useCurrentMusic,
    useMusicState,
    useProgress,
    useRepeatMode,
    useQuality,
    usePlayingQuality,
    useQualitySwitching,
    useCurrentLyric,
    loadCurrentLyric,
    applyQuality,
} from "@/core/trackPlayer";
import type { IQualitySwitchResult } from "@/core/trackPlayer";
import {
    nowPlayingOpenAtom,
    queueOpenAtom,
    openMusicActions,
    openAddToSheet,
    showToast,
} from "@/core/uiAtoms";
import { isLikedMusic, toggleLike, likesVersionAtom } from "@/core/musicSheet";
import { navigate } from "@/core/router";
import { useBackLayer } from "@/core/systemBack";
import { formatSeconds , cssUrl } from "@/core/utils";
import Slider from "@/components/base/Slider";
import {
    IconChevronDown,
    IconShuffle,
    IconRepeatOff,
    IconRepeatSingle,
    IconPrev,
    IconNext,
    IconPlay,
    IconPause,
    IconHeart,
    IconQueue,
    IconLyric,
    IconSpeed,
    IconPlus,
    IconMore,
} from "@/components/base/Icons";

const QUALITY_LABEL: Record<IMusic.IQualityKey, string> = {
    low: "流畅音质",
    standard: "标准音质",
    high: "极高音质",
    super: "无损音质",
};

const QUALITY_ORDER: IMusic.IQualityKey[] = ["low", "standard", "high", "super"];
const RATES = [1, 1.25, 1.5, 0.75];

/** 音质档位的短名（toast / 按钮用） */
function qualityShortName(q: IMusic.IQualityKey) {
    return QUALITY_LABEL[q].replace("音质", "");
}

/** 音质切换结果 → 提示语（"cancelled" 时返回空串，不提示） */
function qualitySwitchToast(res: IQualitySwitchResult, requested: IMusic.IQualityKey): string {
    if (res.status === "switched") {
        return `音质已切换为${qualityShortName(res.quality ?? requested)}`;
    }
    if (res.status === "queued") {
        return `音质已设为${qualityShortName(requested)}，下一次播放时生效`;
    }
    if (res.status === "failed") {
        return `切换到${qualityShortName(requested)}失败：${res.reason ?? "未知原因"}，继续用当前音质播放`;
    }
    return "";
}

export default function NowPlaying() {
    const open = useAtomValue(nowPlayingOpenAtom);
    const setNowPlayingOpen = useSetAtom(nowPlayingOpenAtom);

    // 系统返回（Android 返回键 / iOS 侧滑）先收起本页，而不是退出应用。
    // 注册放在常驻的外层组件里：内层是 open 时才挂载的，开发模式 StrictMode
    // 会对挂载 effect 跑两遍，历史压入/回退就会错位。
    useBackLayer(open, "nowplaying", () => setNowPlayingOpen(false));

    if (!open) {
        return null;
    }
    return <NowPlayingInner />;
}

function NowPlayingInner() {
    const setNowPlayingOpen = useSetAtom(nowPlayingOpenAtom);
    const setQueueOpen = useSetAtom(queueOpenAtom);
    const currentMusic = useCurrentMusic();
    const musicState = useMusicState();
    const progress = useProgress();
    const repeatMode = useRepeatMode();
    const quality = useQuality();
    const playingQuality = usePlayingQuality();
    const lyric = useCurrentLyric();
    const likesVersion = useAtomValue(likesVersionAtom);

    const [showLyrics, setShowLyrics] = useState(false);
    const [rate, setRate] = useState(1);
    const touchStartY = useRef<number | null>(null);
    const switchingQuality = useQualitySwitching();

    void likesVersion;
    const liked = currentMusic ? isLikedMusic(currentMusic) : false;
    const playing = musicState === "playing";
    const spinning = musicState !== "stopped";
    const duration = progress.duration || currentMusic?.duration || 0;
    const position = progress.position || 0;

    useEffect(() => {
        if (currentMusic) {
            loadCurrentLyric(currentMusic);
        }
    }, [currentMusic]);

    // 当前歌词行
    const activeLyricIndex = useMemo(() => {
        if (!lyric.length || !showLyrics) {
            return -1;
        }
        let idx = -1;
        for (let i = 0; i < lyric.length; i += 1) {
            if (lyric[i].time <= position) {
                idx = i;
            } else {
                break;
            }
        }
        return idx;
    }, [lyric, position, showLyrics]);

    const lyricBoxRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (activeLyricIndex < 0 || !lyricBoxRef.current) {
            return;
        }
        const el = lyricBoxRef.current.querySelector(
            `[data-lrc-idx="${activeLyricIndex}"]`,
        ) as HTMLElement | null;
        if (el) {
            lyricBoxRef.current.scrollTo({
                top: el.offsetTop - lyricBoxRef.current.clientHeight / 2 + el.clientHeight / 2,
                behavior: "smooth",
            });
        }
    }, [activeLyricIndex]);

    if (!currentMusic) {
        return null;
    }

    const close = () => {
        setNowPlayingOpen(false);
        setShowLyrics(false);
    };

    const onStageTouchStart = (e: React.TouchEvent) => {
        touchStartY.current = e.touches[0].clientY;
    };
    const onStageTouchEnd = (e: React.TouchEvent) => {
        if (touchStartY.current !== null && e.changedTouches[0].clientY - touchStartY.current > 90) {
            close();
        }
        touchStartY.current = null;
    };

    const cycleQuality = async () => {
        const next = QUALITY_ORDER[(QUALITY_ORDER.indexOf(quality) + 1) % QUALITY_ORDER.length];
        const msg = qualitySwitchToast(await applyQuality(next), next);
        if (msg) {
            showToast(msg);
        }
    };

    const cycleRate = () => {
        const idx = RATES.indexOf(rate);
        const next = RATES[(idx + 1) % RATES.length];
        setRate(next);
        TrackPlayerSingleton.setRate(next);
    };

    const repeatIcon =
        repeatMode === "queue" ? IconShuffle : repeatMode === "single" ? IconRepeatSingle : IconRepeatOff;

    return (
        <div className="np-root">
            <div
                className="np-bg"
                style={{ backgroundImage: cssUrl(currentMusic.artwork) }}
            />
            <div className="np-content">
                <div className="np-header">
                    <button className="icon-btn" onClick={close}>
                        <IconChevronDown size={24} />
                    </button>
                    <div className="np-header-center">
                        <div className="np-header-title">{currentMusic.title}</div>
                        <div className="np-header-artist">{currentMusic.artist}</div>
                    </div>
                    <span style={{ width: 44 }} />
                </div>

                {showLyrics ? (
                    <div className="np-lyrics" ref={lyricBoxRef} onClick={() => setShowLyrics(false)}>
                        {lyric.length ? (
                            lyric.map((line, idx) => (
                                <div
                                    key={idx}
                                    data-lrc-idx={idx}
                                    className={`np-lyric-line ${idx === activeLyricIndex ? "active" : ""}`}
                                >
                                    {line.lrc}
                                </div>
                            ))
                        ) : (
                            <div className="np-lyric-empty">暂无歌词</div>
                        )}
                    </div>
                ) : (
                    <div
                        className="np-stage"
                        onTouchStart={onStageTouchStart}
                        onTouchEnd={onStageTouchEnd}
                        onClick={() => setShowLyrics(true)}
                    >
                        <div className={`np-arm ${playing ? "playing" : ""}`}>
                            <div className="np-arm-pivot" />
                            <div className="np-arm-rod" />
                            <div className="np-arm-head" />
                        </div>
                        <div className="np-vinyl-wrap">
                            <div className={`np-vinyl ${spinning ? "playing" : ""}`}>
                                <div className="np-vinyl-label">
                                    {currentMusic.artwork ? <img src={currentMusic.artwork} alt="" /> : null}
                                </div>
                            </div>
                            <div className="np-vinyl-hole" />
                        </div>
                    </div>
                )}

                <div className="np-title-block">
                    <div className="np-title-main">
                        <div className="np-title">{currentMusic.title}</div>
                        <div className="np-artist">{currentMusic.artist}</div>
                    </div>
                    <div className="np-title-actions">
                        <button
                            className="icon-btn"
                            onClick={() => toggleLike(currentMusic)}
                            style={liked ? { color: "var(--primary-color)" } : undefined}
                        >
                            <IconHeart size={21} filled={liked} />
                        </button>
                        <button
                            className="icon-btn"
                            onClick={() => openAddToSheet([currentMusic])}
                        >
                            <IconPlus size={21} />
                        </button>
                        <button
                            className="icon-btn"
                            onClick={() =>
                                openMusicActions({
                                    musicItem: currentMusic,
                                    actions: [
                                        {
                                            label: "下一首播放",
                                            onClick: () => TrackPlayerSingleton.addNext(currentMusic),
                                        },
                                        {
                                            label: "收藏到歌单",
                                            onClick: () => openAddToSheet([currentMusic]),
                                        },
                                        ...(currentMusic.albumId !== undefined
                                            ? [
                                                  {
                                                      label: "查看专辑",
                                                      onClick: () =>
                                                          navigate("albumDetail", {
                                                              albumItem: {
                                                                  id: currentMusic.albumId,
                                                                  platform: currentMusic.platform,
                                                                  title: currentMusic.album,
                                                                  artwork: currentMusic.artwork,
                                                                  artist: currentMusic.artist,
                                                              },
                                                          }),
                                                  },
                                              ]
                                            : []),
                                    ],
                                })
                            }
                        >
                            <IconMore size={21} />
                        </button>
                    </div>
                </div>

                <div className="np-progress">
                    <span>{formatSeconds(position)}</span>
                    <Slider
                        value={position}
                        max={duration || 1}
                        onCommit={(v) => TrackPlayerSingleton.seekTo(v)}
                    />
                    <span>{formatSeconds(duration)}</span>
                </div>

                <div className="np-controls">
                    <button
                        className="np-ctrl"
                        onClick={() => TrackPlayerSingleton.toggleRepeatMode()}
                    >
                        {repeatIcon({ size: 22 })}
                    </button>
                    <button className="np-ctrl" onClick={() => TrackPlayerSingleton.skipToPrevious()}>
                        <IconPrev size={30} />
                    </button>
                    <button
                        className="np-ctrl np-play"
                        onClick={() => TrackPlayerSingleton.togglePlay()}
                    >
                        {playing ? <IconPause size={30} /> : <IconPlay size={30} />}
                    </button>
                    <button className="np-ctrl" onClick={() => TrackPlayerSingleton.skipToNext()}>
                        <IconNext size={30} />
                    </button>
                    <button className="np-ctrl" onClick={() => setQueueOpen(true)}>
                        <IconQueue size={22} />
                    </button>
                </div>

                <div className="np-toolbar">
                    <button
                        className={`np-tool ${showLyrics ? "active" : ""}`}
                        onClick={() => setShowLyrics((v) => !v)}
                    >
                        <IconLyric size={20} />
                        歌词
                    </button>
                    <button
                        className={`np-tool ${switchingQuality ? "switching" : ""}`}
                        onClick={cycleQuality}
                        title={switchingQuality ? "正在缓冲新音质，当前播放不中断" : "音质"}
                    >
                        <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.5 }}>
                            {QUALITY_LABEL[playingQuality ?? quality].replace("音质", "")}
                        </span>
                        音质
                    </button>
                    <button className="np-tool" onClick={cycleRate}>
                        <IconSpeed size={20} />
                        {rate}x
                    </button>
                    <button className="np-tool" onClick={() => setQueueOpen(true)}>
                        <IconQueue size={20} />
                        队列
                    </button>
                </div>
            </div>
        </div>
    );
}
