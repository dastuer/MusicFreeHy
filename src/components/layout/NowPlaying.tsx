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
    openSingleSelect,
    openAddToSheet,
    showToast,
} from "@/core/uiAtoms";
import { isLikedMusic, toggleLike, likesVersionAtom } from "@/core/musicSheet";
import { navigate } from "@/core/router";
import { useBackLayer } from "@/core/systemBack";
import { formatSeconds, cssUrl } from "@/core/utils";
import {
    QUALITY_LABEL,
    qualityShortName,
    formatQualitySize,
    downloadMusic,
    downloadingAtom,
} from "@/core/musicDownload";
import Slider from "@/components/base/Slider";
import Spinner from "@/components/base/Spinner";
import {
    IconChevronDown,
    IconShuffle,
    IconRepeatOff,
    IconRepeatSingle,
    IconPrev,
    IconNext,
    IconPlay,
    IconPause,
    IconQueue,
    IconHeart,
    IconDownload,
    IconMore,
    IconMusic,
} from "@/components/base/Icons";

const QUALITY_ORDER: IMusic.IQualityKey[] = ["low", "standard", "high", "super"];
const RATE_OPTIONS = [0.75, 1, 1.25, 1.5];

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
    const isDownloading = useAtomValue(downloadingAtom);

    const [showLyrics, setShowLyrics] = useState(false);
    const [rate, setRate] = useState(1);
    const touchStartY = useRef<number | null>(null);
    const switchingQuality = useQualitySwitching();

    void likesVersion;
    const liked = currentMusic ? isLikedMusic(currentMusic) : false;
    const playing = musicState === "playing";
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

    /** 当前歌曲支持的音质档（插件没报 qualities 时给全档） */
    const qualityOptions = () => {
        const supported = QUALITY_ORDER.filter((q) => currentMusic.qualities?.[q]);
        return (supported.length ? supported : QUALITY_ORDER).map((q) => ({
            value: q,
            label: QUALITY_LABEL[q],
            desc: formatQualitySize(currentMusic.qualities?.[q]?.size),
        }));
    };

    const openQualitySheet = () => {
        openSingleSelect({
            title: "播放音质",
            subtitle: switchingQuality ? "正在缓冲新音质，当前播放不中断" : undefined,
            options: qualityOptions(),
            value: quality,
            onSelect: async (v) => {
                const next = v as IMusic.IQualityKey;
                const msg = qualitySwitchToast(await applyQuality(next), next);
                if (msg) {
                    showToast(msg);
                }
            },
        });
    };

    const openDownloadSheet = () => {
        openSingleSelect({
            title: "下载音质",
            options: qualityOptions(),
            onSelect: (v) => {
                downloadMusic(currentMusic, v as IMusic.IQualityKey);
            },
        });
    };

    const openRateSheet = () => {
        openSingleSelect({
            title: "倍速播放",
            options: RATE_OPTIONS.map((r) => ({ value: String(r), label: `${r}x` })),
            value: String(rate),
            onSelect: (v) => {
                const next = Number(v);
                setRate(next);
                TrackPlayerSingleton.setRate(next);
            },
        });
    };

    const openMoreSheet = () => {
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
                {
                    label: "倍速播放",
                    onClick: openRateSheet,
                },
            ],
        });
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
                        <div className="np-cover">
                            {currentMusic.artwork ? (
                                <img src={currentMusic.artwork} alt="" />
                            ) : (
                                <div className="np-cover-fallback">
                                    <IconMusic size={64} />
                                </div>
                            )}
                        </div>
                    </div>
                )}

                <div className="np-func-row">
                    <button
                        className={`np-func ${switchingQuality ? "switching" : ""}`}
                        onClick={openQualitySheet}
                    >
                        <span className="np-func-quality">
                            {qualityShortName(playingQuality ?? quality)}
                        </span>
                    </button>
                    <button
                        className={`np-func ${liked ? "active" : ""}`}
                        style={liked ? { color: "var(--primary-color)" } : undefined}
                        onClick={() => toggleLike(currentMusic)}
                    >
                        <IconHeart size={24} filled={liked} />
                    </button>
                    <button className="np-func" onClick={openDownloadSheet}>
                        {isDownloading ? <Spinner size={24} /> : <IconDownload size={24} />}
                    </button>
                    <button className="np-func" onClick={openMoreSheet}>
                        <IconMore size={24} />
                    </button>
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
            </div>
        </div>
    );
}
