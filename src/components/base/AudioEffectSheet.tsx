import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import {
    closeAudioEffectSheet,
    audioEffectOpenAtom,
    showToast,
} from "@/core/uiAtoms";
import { useBackLayer } from "@/core/systemBack";
import { IconCheck, IconChevronDown, IconClose } from "./Icons";
import {
    CUSTOM_PRESET_NAME,
    EQ_BAND_LABELS,
    EQ_BANDS,
    EQ_GAIN_RANGE,
    EQ_PRESETS,
    REVERB_PRESETS,
    SURROUND_RANGE,
    TONE_RANGE,
    USER_PRESET_NAME,
    applyPreset,
    previewBand,
    previewSurround,
    previewTone,
    resetEqualizer,
    saveUserPreset,
    setBandGain,
    setBassGain,
    setEffectEnabled,
    setReverbPreset,
    setSurround,
    setTrebleGain,
    useAudioEffect,
} from "@/core/audioEffect";

/**
 * 音效面板（布局与桌面版 AudioEffectPanel 同一套，按移动端改成全宽底部面板）：
 *
 *   均衡器 [超重低音 ⌄] (保存)        [开关]
 *   +12dB ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉
 *        31 63 125 250 500 1k 2k 4k 8k 16k
 *   增强音效 (重置)
 *   − ──●──── +      − ──●──── +
 *       低音              高音
 *   − ──●──── +      − ──●──── +
 *     环绕深度          环绕强度
 *   环境音效 [音乐厅 ⌄]
 *
 * 与桌面版的差异：环绕深度/强度取值 0~100%（Android Virtualizer 只支持加宽，
 * 见 audioEffect.ts 顶部说明）；推子高度与触控命中区按手机放大。
 */

export default function AudioEffectSheet() {
    const open = useAtomValue(audioEffectOpenAtom);
    /** 二级选择浮层（预设 / 环境音效共用）：原生 <select> 的系统单选框与主题违和 */
    const [picker, setPicker] = useState<null | {
        title: string;
        options: { value: string; label: string }[];
        value: string;
        onSelect: (v: string) => void;
    }>(null);

    // 系统返回：选择器浮层在栈顶先消费，然后才是面板
    useBackLayer(open && picker !== null, "audio-effect-picker", () => setPicker(null));
    useBackLayer(open, "audio-effect", closeAudioEffectSheet);

    // 打开面板时把设置补发给原生一次：WebView 冻结期间原生服务可能被杀重建，
    // 面板打开是用户一定在场的时机，兜底同步
    useEffect(() => {
        if (!open) {
            return;
        }
        // 延迟动态引入避免模块初始化顺序问题（audioEffect 依赖 trackPlayer）
        void import("@/core/audioEffect").then((m) => m.syncAudioEffectToNative());
    }, [open]);

    if (!open) {
        return null;
    }

    return (
        <div className="sheet-mask" onClick={() => closeAudioEffectSheet()}>
            <div className="audio-effect-panel" onClick={(e) => e.stopPropagation()}>
                <AudioEffectBody openPicker={setPicker} />
            </div>
            {picker && (
                /* 二级选择浮层：盖在音效面板之上；点遮罩收起，返回键同效 */
                <div
                    className="fx-picker-mask"
                    onClick={(e) => {
                        e.stopPropagation();
                        setPicker(null);
                    }}
                >
                    <div className="fx-picker" onClick={(e) => e.stopPropagation()}>
                        <div className="fx-picker-title">{picker.title}</div>
                        <div className="fx-picker-list">
                            {picker.options.map((opt) => {
                                const active = opt.value === picker.value;
                                return (
                                    <button
                                        key={opt.value}
                                        ref={
                                            active
                                                ? (el) => {
                                                      // 打开时把当前选中项滚到可视区中部：
                                                      // 长列表（24 套预设）不滚的话选中项多半在屏幕外
                                                      if (el) {
                                                          requestAnimationFrame(() =>
                                                              el.scrollIntoView({
                                                                  block: "center",
                                                              }),
                                                          );
                                                      }
                                                  }
                                                : undefined
                                        }
                                        className={`fx-picker-item${active ? " active" : ""}`}
                                        onClick={() => {
                                            picker.onSelect(opt.value);
                                            setPicker(null);
                                        }}
                                    >
                                        <span className="fx-picker-item-label">{opt.label}</span>
                                        {active && (
                                            <span className="source-select-check">
                                                <IconCheck size={15} />
                                            </span>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

function AudioEffectBody(props: {
    openPicker: (state: {
        title: string;
        options: { value: string; label: string }[];
        value: string;
        onSelect: (v: string) => void;
    }) => void;
}) {
    const { openPicker } = props;
    const settings = useAudioEffect();
    const surroundText = (v: number) => `${Math.round(v * 100)}%`;

    const presetOptions = [
        ...(settings.userPreset ? [USER_PRESET_NAME] : []),
        ...EQ_PRESETS.map((item) => item.name),
    ];
    const selectValue = presetOptions.includes(settings.preset)
        ? settings.preset
        : CUSTOM_PRESET_NAME;

    return (
        <>
            {/* 头部：标题 + 总开关 + 关闭 */}
            <div className="audio-effect-header">
                <span className="audio-effect-title">音效</span>
                <div className="audio-effect-switch">
                    <span className="audio-effect-switch-text">
                        {settings.enabled ? "已开启" : "已关闭"}
                    </span>
                    <button
                        className={`switch-pill${settings.enabled ? " on" : ""}`}
                        onClick={() => setEffectEnabled(!settings.enabled)}
                    >
                        <span className="switch-knob" />
                    </button>
                </div>
                <button className="icon-btn" onClick={() => closeAudioEffectSheet()}>
                    <IconClose size={20} />
                </button>
            </div>

            <div className={`audio-effect-body${settings.enabled ? "" : " disabled"}`}>
                {/* 预设行：下拉 + 保存 */}
                <div className="eq-preset-row">
                    <span className="eq-preset-label">均衡器</span>
                    <button
                        className="pill-select"
                        onClick={() =>
                            openPicker({
                                title: "选择均衡器预设",
                                options: [
                                    ...(settings.preset === CUSTOM_PRESET_NAME
                                        ? [
                                              {
                                                  value: CUSTOM_PRESET_NAME,
                                                  label: CUSTOM_PRESET_NAME,
                                              },
                                          ]
                                        : []),
                                    ...presetOptions.map((name) => ({ value: name, label: name })),
                                ],
                                value: selectValue,
                                onSelect: (v) => applyPreset(v),
                            })
                        }
                    >
                        <span className="pill-select-value">{selectValue}</span>
                        <span className="pill-select-caret">
                            <IconChevronDown size={15} />
                        </span>
                    </button>
                    <button
                        className="eq-preset-save"
                        onClick={() => {
                            saveUserPreset();
                            showToast("已保存为「我的音效」");
                        }}
                    >
                        保存
                    </button>
                </div>

                {/* 十段推子 */}
                <div className="eq-board">
                    <div className="eq-scale">
                        <span>+12dB</span>
                        <span>0</span>
                        <span>−12dB</span>
                    </div>
                    <div className="eq-faders">
                        {EQ_BANDS.map((_, index) => (
                            <EqFader
                                key={EQ_BAND_LABELS[index]}
                                label={EQ_BAND_LABELS[index]}
                                value={settings.eqs[index]}
                                onChange={(v) => previewBand(index, v)}
                                onCommit={(v) => setBandGain(index, v)}
                            />
                        ))}
                    </div>
                </div>

                {/* 增强音效 */}
                <div className="audio-effect-section-head">
                    <span className="audio-effect-section-title">增强音效</span>
                    <button className="audio-effect-reset" onClick={resetEqualizer}>
                        重置
                    </button>
                </div>
                <div className="hs-grid">
                    <HSlider
                        label="低音"
                        value={settings.bass}
                        min={TONE_RANGE.min}
                        max={TONE_RANGE.max}
                        format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}dB`}
                        onChange={(v) => previewTone("bass", v)}
                        onCommit={(v) => setBassGain(v)}
                    />
                    <HSlider
                        label="高音"
                        value={settings.treble}
                        min={TONE_RANGE.min}
                        max={TONE_RANGE.max}
                        format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}dB`}
                        onChange={(v) => previewTone("treble", v)}
                        onCommit={(v) => setTrebleGain(v)}
                    />
                    <HSlider
                        label="环绕深度"
                        value={settings.surroundDepth}
                        min={SURROUND_RANGE.min}
                        max={SURROUND_RANGE.max}
                        format={surroundText}
                        onChange={(v) => previewSurround("depth", v)}
                        onCommit={(v) => setSurround("depth", v)}
                    />
                    <HSlider
                        label="环绕强度"
                        value={settings.surroundStrength}
                        min={SURROUND_RANGE.min}
                        max={SURROUND_RANGE.max}
                        format={surroundText}
                        onChange={(v) => previewSurround("strength", v)}
                        onCommit={(v) => setSurround("strength", v)}
                    />
                </div>

                {/* 环境音效 */}
                <div className="reverb-row">
                    <span className="reverb-label">环境音效</span>
                    <button
                        className="pill-select"
                        onClick={() =>
                            openPicker({
                                title: "选择环境音效",
                                options: REVERB_PRESETS.map((preset) => ({
                                    value: preset.name,
                                    label: preset.name,
                                })),
                                value: settings.reverb,
                                onSelect: (v) => setReverbPreset(v),
                            })
                        }
                    >
                        <span className="pill-select-value">{settings.reverb}</span>
                        <span className="pill-select-caret">
                            <IconChevronDown size={15} />
                        </span>
                    </button>
                </div>
            </div>
        </>
    );
}

/**
 * 竖向 EQ 推子：填充条从轨道底端（−12dB）长到当前位置，正负同色；
 * 拖动时上方浮出数值气泡。命中区整格可点（手机触控），不是只有细轨道。
 */
function EqFader(props: {
    label: string;
    value: number;
    onChange: (v: number) => void;
    onCommit: (v: number) => void;
}) {
    const { label, value, onChange, onCommit } = props;
    const trackRef = useRef<HTMLDivElement | null>(null);
    const [dragging, setDragging] = useState(false);
    const [dragValue, setDragValue] = useState(0);
    const displayValue = dragging ? dragValue : value;

    const { min, max } = EQ_GAIN_RANGE;
    const percent = (displayValue - min) / (max - min);
    const zeroPercent = (0 - min) / (max - min);

    const valueFromClientY = (clientY: number) => {
        const el = trackRef.current;
        if (!el) {
            return 0;
        }
        const rect = el.getBoundingClientRect();
        if (rect.height === 0) {
            return 0;
        }
        const ratio = Math.min(1, Math.max(0, (rect.bottom - clientY) / rect.height));
        return min + ratio * (max - min);
    };

    const onPointerDown = (e: React.PointerEvent) => {
        e.stopPropagation();
        setDragging(true);
        const v = valueFromClientY(e.clientY);
        setDragValue(v);
        onChange(v);
        const onMove = (ev: PointerEvent) => {
            const nv = valueFromClientY(ev.clientY);
            setDragValue(nv);
            onChange(nv);
        };
        const onUp = (ev: PointerEvent) => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            const nv = valueFromClientY(ev.clientY);
            onCommit(nv);
            setDragging(false);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    return (
        <div className="eq-fader">
            <div
                className={`eq-fader-track${dragging ? " dragging" : ""}`}
                ref={trackRef}
                onPointerDown={onPointerDown}
            >
                <div className="eq-fader-rail" />
                <div className="eq-fader-zero" style={{ bottom: `${zeroPercent * 100}%` }} />
                <div className="eq-fader-fill" style={{ height: `${percent * 100}%` }} />
                <div className="eq-fader-thumb" style={{ bottom: `${percent * 100}%` }} />
                {dragging && (
                    <div className="fader-bubble" style={{ bottom: `${percent * 100}%` }}>
                        {displayValue > 0 ? "+" : ""}
                        {displayValue.toFixed(1)}
                    </div>
                )}
            </div>
            <div className="eq-fader-label">{label}</div>
        </div>
    );
}

/** 横向滑块（低音/高音/环绕）：填充从最左端长到当前位置，正负同色 */
function HSlider(props: {
    label: string;
    value: number;
    min: number;
    max: number;
    format: (v: number) => string;
    onChange: (v: number) => void;
    onCommit: (v: number) => void;
}) {
    const { label, value, min, max, format, onChange, onCommit } = props;
    const trackRef = useRef<HTMLDivElement | null>(null);
    const [dragging, setDragging] = useState(false);
    const [dragValue, setDragValue] = useState(0);
    const displayValue = dragging ? dragValue : value;
    const percent = (displayValue - min) / (max - min);
    const centerPercent = (0 - min) / (max - min);

    const valueFromClientX = (clientX: number) => {
        const el = trackRef.current;
        if (!el) {
            return min;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width === 0) {
            return min;
        }
        const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        return min + ratio * (max - min);
    };

    const onPointerDown = (e: React.PointerEvent) => {
        e.stopPropagation();
        setDragging(true);
        const v = valueFromClientX(e.clientX);
        setDragValue(v);
        onChange(v);
        const onMove = (ev: PointerEvent) => {
            const nv = valueFromClientX(ev.clientX);
            setDragValue(nv);
            onChange(nv);
        };
        const onUp = (ev: PointerEvent) => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            const nv = valueFromClientX(ev.clientX);
            onCommit(nv);
            setDragging(false);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    return (
        <div className="hs-row">
            <div className="hs-control">
                <span className="hs-end">−</span>
                <div
                    className={`hs-track${dragging ? " dragging" : ""}`}
                    ref={trackRef}
                    onPointerDown={onPointerDown}
                >
                    <div className="hs-rail" />
                    <div className="hs-center" style={{ left: `${centerPercent * 100}%` }} />
                    <div className="hs-fill" style={{ width: `${percent * 100}%` }} />
                    <div className="hs-thumb" style={{ left: `${percent * 100}%` }} />
                    {dragging && (
                        <div className="fader-bubble" style={{ left: `${percent * 100}%` }}>
                            {format(displayValue)}
                        </div>
                    )}
                </div>
                <span className="hs-end">+</span>
            </div>
            <div className="hs-label">{label}</div>
        </div>
    );
}
