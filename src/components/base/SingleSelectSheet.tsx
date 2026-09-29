import { useAtomValue } from "jotai";
import { closeSingleSelect, singleSelectAtom } from "@/core/uiAtoms";
import { useBackLayer } from "@/core/systemBack";
import { IconCheck } from "./Icons";

/**
 * 单选底部浮窗：设置页等多选一项的统一交互。
 * 点行即选中并收起，当前值打勾。
 */
export default function SingleSelectSheet() {
    const state = useAtomValue(singleSelectAtom);
    const open = state !== null;

    // 系统返回先收起浮窗
    useBackLayer(open, "single-select", closeSingleSelect);

    if (!state) {
        return null;
    }

    return (
        <div className="sheet-mask" onClick={() => closeSingleSelect()}>
            <div className="add-sheet-panel" onClick={(e) => e.stopPropagation()}>
                <div className="add-sheet-header">{state.title}</div>
                {state.subtitle && (
                    <div className="source-select-sub">{state.subtitle}</div>
                )}
                <div className="add-sheet-list">
                    {state.options.map((opt) => {
                        const active = opt.value === state.value;
                        return (
                            <div
                                key={opt.value}
                                className="add-sheet-row"
                                onClick={() => {
                                    state.onSelect(opt.value);
                                    closeSingleSelect();
                                }}
                            >
                                <div className="add-sheet-row-info">
                                    <div className="add-sheet-row-title">{opt.label}</div>
                                    {opt.desc && (
                                        <div className="add-sheet-row-sub">{opt.desc}</div>
                                    )}
                                </div>
                                {active && (
                                    <span className="source-select-check">
                                        <IconCheck size={17} />
                                    </span>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
