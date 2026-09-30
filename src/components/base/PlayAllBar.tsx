import { IconCheck, IconMultiSelect, IconPlay } from "./Icons";

/**
 * 「播放全部」栏（网易云风格）：
 *  - 常态：红色圆形播放钮 + 播放全部 (N)，右侧多选入口（可选）；
 *  - 多选态：左侧「全选」，右侧「完成」。
 */
export default function PlayAllBar({
    count,
    onPlayAll,
    selectMode = false,
    selectedCount = 0,
    onEnterSelect,
    onExitSelect,
    onSelectAll,
    onDeselectAll,
}: {
    count: number;
    onPlayAll: () => void;
    selectMode?: boolean;
    selectedCount?: number;
    onEnterSelect?: () => void;
    onExitSelect?: () => void;
    onSelectAll?: () => void;
    onDeselectAll?: () => void;
}) {
    if (selectMode) {
        return (
            <div className="detail-playall select-mode">
                <button
                    className="pa-select-all"
                    onClick={() => {
                        if (selectedCount >= count) {
                            onDeselectAll?.();
                        } else {
                            onSelectAll?.();
                        }
                    }}
                >
                    <span
                        className={`row-check ${selectedCount >= count && count > 0 ? "checked" : ""}`}
                    >
                        <IconCheck size={12} />
                    </span>
                    全选
                </button>
                <span className="pa-selected-tip">已选 {selectedCount} 首</span>
                <button className="pa-done" onClick={() => onExitSelect?.()}>
                    完成
                </button>
            </div>
        );
    }
    return (
        <div className="detail-playall" onClick={onPlayAll}>
            <span className="pa-icon">
                <IconPlay size={14} />
            </span>
            <span className="pa-text">播放全部</span>
            <span className="pa-sub">({count})</span>
            {onEnterSelect && (
                <button
                    className="pa-select icon-btn"
                    onClick={(e) => {
                        e.stopPropagation();
                        onEnterSelect();
                    }}
                    title="多选"
                >
                    <IconMultiSelect size={20} />
                </button>
            )}
        </div>
    );
}
