import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { promptAtom, closePrompt } from "@/core/uiAtoms";
import { useBackLayer } from "@/core/systemBack";

/** 输入对话框（新建/重命名歌单等） */
export default function PromptDialog() {
    const state = useAtomValue(promptAtom);
    const [value, setValue] = useState("");
    const inputRef = useRef<HTMLInputElement | null>(null);

    // 系统返回等同于「取消」
    useBackLayer(!!state, "prompt-dialog", closePrompt);

    useEffect(() => {
        if (state) {
            setValue(state.defaultValue ?? "");
            setTimeout(() => inputRef.current?.focus(), 60);
        }
    }, [state]);

    if (!state) {
        return null;
    }

    const confirm = () => {
        closePrompt();
        state.onConfirm(value.trim());
    };

    return (
        <div className="sheet-mask dialog-mask" onClick={() => closePrompt()}>
            <div className="prompt-dialog" onClick={(e) => e.stopPropagation()}>
                <div className="prompt-title">{state.title}</div>
                <input
                    ref={inputRef}
                    className="prompt-input"
                    value={value}
                    placeholder={state.placeholder}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            confirm();
                        }
                    }}
                />
                <div className="prompt-actions">
                    <button className="prompt-btn" onClick={() => closePrompt()}>
                        取消
                    </button>
                    <button className="prompt-btn primary" onClick={confirm}>
                        {state.confirmText ?? "确定"}
                    </button>
                </div>
            </div>
        </div>
    );
}
