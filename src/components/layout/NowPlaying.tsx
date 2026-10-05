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
    qualityRank,
} from "@/core/trackPlayer";
import type { IQualitySwitchResult } from "@/core/trackPlayer";
import {
    nowPlayingOpenAtom,
    queueOpenAtom,
    openMusicActions,
    openSingleSelect,
    openAddToSheet,
    showToast,
    lyricTranslationAtom,
} from "@/core/uiAtoms";
import { isLikedMusic, toggleLike, likesVersionAtom } from "@/core/musicSheet";
import { localMusicVersionAtom, findLocalRecord, matchSingleLocalMusic } from "@/core/localMusic";
import { navigate } from "@/core/router";
import { useBackLayer } from "@/core/systemBack";
import { formatSeconds, cssUrl } from "@/core/utils";
import {
    QUALITY_LABEL,
    qualityShortName,
    formatQualitySize,
    downloadMusic,
    downloadingAtom,
    getDownloadRecord,
    downloadsVersionAtom,
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

/** 歌词滑动激活判定区左右留白：起手落在边缘内不进入激活态，让位给系统侧滑返回 */
const LYRIC_EDGE_MARGIN = 32;

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
    // visible 期间包含退出动画：open 变 false 后先播 np-out（下滑渐隐），
    // 动画结束回调里才真正卸载，否则退场动画没有播放时机。
    const [visible, setVisible] = useState(open);
    const [leaving, setLeaving] = useState(false);
    const leaveTimerRef = useRef<number | null>(null);

    // 系统返回（Android 返回键 / iOS 侧滑）先收起本页，而不是退出应用。
    // 注册放在常驻的外层组件里：内层是 open 时才挂载的，开发模式 StrictMode
    // 会对挂载 effect 跑两遍，历史压入/回退就会错位。
    useBackLayer(open, "nowplaying", () => setNowPlayingOpen(false));

    useEffect(() => {
        if (open) {
            setLeaving(false);
            setVisible(true);
        } else {
            setLeaving(true);
            // 兜底：页面不可见等场景下 animationend 可能不派发，超时后强制卸载
            if (leaveTimerRef.current !== null) {
                clearTimeout(leaveTimerRef.current);
            }
            leaveTimerRef.current = window.setTimeout(() => {
                leaveTimerRef.current = null;
                setVisible(false);
                setLeaving(false);
            }, 450);
        }
        return () => {
            if (leaveTimerRef.current !== null) {
                clearTimeout(leaveTimerRef.current);
                leaveTimerRef.current = null;
            }
        };
    }, [open]);

    if (!visible) {
        return null;
    }
    return (
        <NowPlayingInner
            leaving={leaving}
            onLeaveEnd={() => {
                setVisible(false);
                setLeaving(false);
            }}
        />
    );
}

function NowPlayingInner({
    leaving,
    onLeaveEnd,
}: {
    leaving: boolean;
    onLeaveEnd: () => void;
}) {
    const setNowPlayingOpen = useSetAtom(nowPlayingOpenAtom);
    const setQueueOpen = useSetAtom(queueOpenAtom);
    const currentMusic = useCurrentMusic();
    const musicState = useMusicState();
    const progress = useProgress();
    const repeatMode = useRepeatMode();
    const quality = useQuality();
    const playingQuality = usePlayingQuality();
    const lyric = useCurrentLyric();
    const showTranslation = useAtomValue(lyricTranslationAtom);
    const likesVersion = useAtomValue(likesVersionAtom);
    const isDownloading = useAtomValue(downloadingAtom);
    // 本地音乐曲库版本号：单曲匹配成功后 bump，驱动这里的按钮状态与封面歌词刷新
    const lmVersion = useAtomValue(localMusicVersionAtom);
    void lmVersion;
    const [matchingMeta, setMatchingMeta] = useState(false);

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

    // 用户手动滑动歌词期间暂停自动跟随，停止滑动一段时间后恢复，避免和用户抢焦点。
    // 停止滑动后，会把目标行平滑滚到激活位置（与自动跟随一致），并在该行内嵌展示 时间 + 播放按钮。
    const [isSeekingLyric, setIsSeekingLyric] = useState(false);
    const [seekTargetIndex, setSeekTargetIndex] = useState(-1);
    const [seekScrollTick, setSeekScrollTick] = useState(0);
    const isSeekingRef = useRef(false);
    const touchActiveRef = useRef(false);
    const settleTimerRef = useRef<number | null>(null);
    const resumeTimerRef = useRef<number | null>(null);

    useEffect(
        () => () => {
            if (resumeTimerRef.current !== null) {
                clearTimeout(resumeTimerRef.current);
            }
            if (settleTimerRef.current !== null) {
                clearTimeout(settleTimerRef.current);
            }
        },
        [],
    );

    /** 单行歌词高度 */
    const lyricLineHeight = (box: HTMLDivElement) => {
        const first = box.querySelector<HTMLElement>("[data-lrc-idx]");
        return first?.offsetHeight ?? 41;
    };

    /** 计算当前停在激活位置（中线偏下两行，与自动跟随一致）的那一行 */
    const calcFocusLineIndex = () => {
        const box = lyricBoxRef.current;
        if (!box || !lyric.length) {
            return -1;
        }
        const focusY = box.scrollTop + box.clientHeight / 2 + lyricLineHeight(box) * 2;
        let idx = 0;
        box.querySelectorAll<HTMLElement>("[data-lrc-idx]").forEach((el) => {
            if (el.offsetTop <= focusY) {
                idx = Number(el.dataset.lrcIdx);
            }
        });
        return idx;
    };

    const clearSeekTimers = () => {
        if (resumeTimerRef.current !== null) {
            clearTimeout(resumeTimerRef.current);
            resumeTimerRef.current = null;
        }
        if (settleTimerRef.current !== null) {
            clearTimeout(settleTimerRef.current);
            settleTimerRef.current = null;
        }
    };

    const endSeek = () => {
        clearSeekTimers();
        isSeekingRef.current = false;
        setIsSeekingLyric(false);
        setSeekTargetIndex(-1);
    };

    const beginSeek = () => {
        clearSeekTimers();
        isSeekingRef.current = true;
        setIsSeekingLyric(true);
        setSeekTargetIndex(calcFocusLineIndex());
    };

    /** 3s 内没有新的滑动就恢复自动跟随 */
    const scheduleResume = () => {
        if (resumeTimerRef.current !== null) {
            clearTimeout(resumeTimerRef.current);
        }
        resumeTimerRef.current = window.setTimeout(() => {
            resumeTimerRef.current = null;
            endSeek();
        }, 3000);
    };

    /** 滑动彻底停止（惯性滚动结束）后：把目标行滚到激活位置，再等待恢复自动跟随 */
    const startSettleCountdown = () => {
        if (settleTimerRef.current !== null) {
            clearTimeout(settleTimerRef.current);
        }
        settleTimerRef.current = window.setTimeout(() => {
            settleTimerRef.current = null;
            if (!isSeekingRef.current || !lyricBoxRef.current) {
                return;
            }
            const idx = calcFocusLineIndex();
            if (idx >= 0) {
                setSeekTargetIndex(idx);
                setSeekScrollTick((t) => t + 1);
            }
            scheduleResume();
        }, 200);
    };

    const onLyricTouchStart = (e: React.TouchEvent) => {
        touchActiveRef.current = true;
        // 起手落在左右边缘留白内（系统侧滑返回的起手区）：不算滑动激活，
        // 只暂停自动跟随；滚动照常，但不弹激活卡片
        const x = e.touches[0]?.clientX ?? 0;
        if (x < LYRIC_EDGE_MARGIN || x > window.innerWidth - LYRIC_EDGE_MARGIN) {
            return;
        }
        beginSeek();
    };

    const onLyricTouchEnd = () => {
        touchActiveRef.current = false;
        if (isSeekingRef.current) {
            startSettleCountdown();
        }
    };

    // 侧滑返回等系统手势会接管触摸：以 cancel 收尾（不触发 touchend），这里只复位标记
    const onLyricTouchCancel = () => {
        touchActiveRef.current = false;
    };

    const onLyricWheel = () => {
        beginSeek();
        touchActiveRef.current = false;
        startSettleCountdown();
    };

    const onLyricScroll = () => {
        if (!isSeekingRef.current) {
            return;
        }
        setSeekTargetIndex(calcFocusLineIndex());
        if (touchActiveRef.current) {
            // 手指还按着，不判定停止
            if (settleTimerRef.current !== null) {
                clearTimeout(settleTimerRef.current);
                settleTimerRef.current = null;
            }
        } else {
            startSettleCountdown();
        }
    };

    const playSeekTarget = () => {
        const target = lyric[seekTargetIndex];
        if (target) {
            TrackPlayerSingleton.seekTo(target.time);
        }
        endSeek();
    };

    // 停止滑动后把目标行平滑滚到激活位置（与自动跟随一致；依赖 tick 触发，拖动过程中不打断用户）
    useEffect(() => {
        if (!seekScrollTick || !isSeekingLyric || seekTargetIndex < 0) {
            return;
        }
        const box = lyricBoxRef.current;
        if (!box) {
            return;
        }
        const el = box.querySelector<HTMLElement>(`[data-lrc-idx="${seekTargetIndex}"]`);
        if (el) {
            box.scrollTo({
                top:
                    el.offsetTop -
                    box.clientHeight / 2 +
                    el.clientHeight / 2 -
                    lyricLineHeight(box) * 2,
                behavior: "smooth",
            });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [seekScrollTick]);

    // 自动跟随：激活行落在中线下方两行；用户滑动期间跳过（含边缘起手、未进入激活态的滑动）
    useEffect(() => {
        const box = lyricBoxRef.current;
        if (isSeekingLyric || activeLyricIndex < 0 || !box) {
            return;
        }
        if (touchActiveRef.current) {
            // 手指还按在歌词上，不抢焦点；松手后由下一次进度更新接管
            return;
        }
        const el = box.querySelector<HTMLElement>(`[data-lrc-idx="${activeLyricIndex}"]`);
        if (el) {
            box.scrollTo({
                top:
                    el.offsetTop -
                    box.clientHeight / 2 +
                    el.clientHeight / 2 -
                    lyricLineHeight(box) * 2,
                behavior: "smooth",
            });
        }
    }, [activeLyricIndex, isSeekingLyric]);

    if (!currentMusic) {
        return null;
    }

    /* 本地音乐「获取封面歌词」（参考网易云）：歌词或封面没就绪时给一键匹配入口，
       匹配成功后播放器条目被更新，这里经曲库版本号与 currentMusic 自动刷新 */
    const localRecord =
        currentMusic.platform === "local" ? findLocalRecord(currentMusic) : undefined;
    const canFetchMeta =
        !!localRecord &&
        (!localRecord.lyricPath || !(localRecord.matchedArtwork || localRecord.artwork));

    const fetchMetaForCurrent = async () => {
        if (matchingMeta) {
            return;
        }
        setMatchingMeta(true);
        try {
            const r = await matchSingleLocalMusic(currentMusic);
            if (!r.matched) {
                showToast("没有匹配到合适的歌词或封面");
            } else {
                const got = [r.gotLyric ? "歌词" : "", r.gotCover ? "封面" : ""]
                    .filter(Boolean)
                    .join("与");
                showToast(`已获取${got}`);
            }
        } catch (e: any) {
            showToast(e?.message ?? String(e), 3600);
        } finally {
            setMatchingMeta(false);
        }
    };

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

    // 下载记录版本号：换歌 / 记录变化后重算各音质档的已下载标注
    const downloadsVersion = useAtomValue(downloadsVersionAtom);
    const downloadedRecord = useMemo(() => {
        void downloadsVersion;
        return currentMusic ? getDownloadRecord(currentMusic) : undefined;
    }, [currentMusic, downloadsVersion]);

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
            options: qualityOptions().map((opt) => {
                const q = opt.value as IMusic.IQualityKey;
                // 已下载标注：同档或更低 → 重复下载会被跳过；更高 → 覆盖升级
                const existing = downloadedRecord?.quality;
                if (existing) {
                    const rank = qualityRank(q) - qualityRank(existing);
                    if (rank < 0) {
                        return { ...opt, desc: "已有更高音质，下载会跳过" };
                    }
                    if (rank === 0) {
                        return { ...opt, desc: "已下载，重复下载会跳过" };
                    }
                    return { ...opt, desc: "覆盖升级现有文件" };
                }
                return opt;
            }),
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
                ...(currentMusic.artistId !== undefined
                    ? [
                          {
                              label: "查看歌手",
                              onClick: () =>
                                  navigate("artistDetail", {
                                      artistItem: {
                                          id: currentMusic.artistId,
                                          platform: currentMusic.platform,
                                          name: currentMusic.artist,
                                          avatar: currentMusic.artwork,
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
        <div
            className={`np-root${leaving ? " np-out" : ""}`}
            onAnimationEnd={(e) => {
                // animationend 会从子元素冒泡（如旋转中的 Spinner），只认根节点自己的 np-out
                if (leaving && e.target === e.currentTarget && e.animationName === "np-out") {
                    onLeaveEnd();
                }
            }}
        >
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
                    <div
                        className="np-lyrics"
                        ref={lyricBoxRef}
                        onTouchStart={onLyricTouchStart}
                        onTouchEnd={onLyricTouchEnd}
                        onTouchCancel={onLyricTouchCancel}
                        onWheel={onLyricWheel}
                        onScroll={onLyricScroll}
                        onClick={() => setShowLyrics(false)}
                    >
                        {lyric.length
                            ? lyric.map((line, idx) => {
                                  if (isSeekingLyric && idx === seekTargetIndex) {
                                      return (
                                          <div
                                              key={idx}
                                              data-lrc-idx={idx}
                                              className="np-lyric-line np-lyric-seekline"
                                              onClick={(e) => e.stopPropagation()}
                                          >
                                              <span className="np-lyric-seek-time">
                                                  {formatSeconds(line.time)}
                                              </span>
                                              <div className="np-lyric-seek-text">
                                                  {line.lrc}
                                                  {showTranslation && line.translation && (
                                                      <div className="np-lyric-trans">
                                                          {line.translation}
                                                      </div>
                                                  )}
                                              </div>
                                              <button
                                                  className="np-lyric-seek-play"
                                                  onClick={playSeekTarget}
                                              >
                                                  <IconPlay size={20} />
                                              </button>
                                          </div>
                                      );
                                  }
                                  return (
                                      <div
                                          key={idx}
                                          data-lrc-idx={idx}
                                          className={`np-lyric-line ${
                                              idx ===
                                              (isSeekingLyric ? seekTargetIndex : activeLyricIndex)
                                                  ? "active"
                                                  : ""
                                          }`}
                                      >
                                          {line.lrc}
                                          {showTranslation && line.translation && (
                                              <div className="np-lyric-trans">
                                                  {line.translation}
                                              </div>
                                          )}
                                      </div>
                                  );
                              })
                            : (
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

                {canFetchMeta && (
                    <div className="np-fetch-row">
                        <button
                            className="np-fetch-btn"
                            disabled={matchingMeta}
                            onClick={fetchMetaForCurrent}
                        >
                            {matchingMeta ? (
                                <>
                                    <Spinner size={12} strokeWidth={2.2} />
                                    正在获取…
                                </>
                            ) : (
                                "获取封面歌词"
                            )}
                        </button>
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
                        {musicState === "loading" ? (
                            <Spinner size={30} strokeWidth={2.6} />
                        ) : playing ? (
                            <IconPause size={30} />
                        ) : (
                            <IconPlay size={30} />
                        )}
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
