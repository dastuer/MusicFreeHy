import { createPortal } from "react-dom";
import { useBackLayer } from "@/core/systemBack";
import { IconClose } from "@/components/base/Icons";

/**
 * 歌单分类浮窗：参考原版 MusicFree 的 SheetTags 面板（70vh 底部弹层）。
 * 内容为二级分类结构：「精选」置顶行 + 一级分组标题 + 各组二级标签胶囊。
 * 标签对象与外部列表共用同一引用，选中态直接按引用比较。
 *
 * 必须用 portal 挂到 body：发现页三个子页在带 transform 的横滑轨道里，
 * transform 祖先会劫持 position:fixed 的包含块，直接渲染会让遮罩/浮窗
 * 被限制在子页区域内（盖不住底部导航、垂直锚点错位）。
 */
export interface ISheetTagGroups {
    pinned: any[];
    groups: { title?: string; data?: any[] }[];
}

export default function SheetTagsPanel({
    open,
    tagGroups,
    activeTag,
    onPick,
    onClose,
}: {
    open: boolean;
    tagGroups: ISheetTagGroups | null;
    activeTag: any;
    onPick: (tag: any) => void;
    onClose: () => void;
}) {
    // 系统返回先收起浮窗（hook 需无条件调用，内部自行判断 open）
    useBackLayer(open, "sheet-tags-panel", onClose);

    if (!open) {
        return null;
    }
    const pinned = (tagGroups?.pinned ?? []).filter((t) => t && typeof t === "object");
    const groups = (tagGroups?.groups ?? []).filter((g) => g && typeof g === "object");

    return createPortal(
        <div className="sheet-mask" onClick={onClose}>
            <div className="tags-panel" onClick={(e) => e.stopPropagation()}>
                <div className="tags-panel-header">
                    <span className="tags-panel-title">歌单分类</span>
                    <button className="icon-btn" onClick={onClose}>
                        <IconClose size={18} />
                    </button>
                </div>
                <div className="tags-panel-body">
                    {pinned.length > 0 && (
                        <>
                            <div className="tags-group-title">精选</div>
                            <div className="tags-group-chips">
                                {pinned.map((tag: any, idx: number) => (
                                    <TagChip key={`p-${idx}`} tag={tag} activeTag={activeTag} onPick={onPick} />
                                ))}
                            </div>
                        </>
                    )}
                    {groups.map((g: any, gi: number) => {
                        const children = (g.data ?? []).filter(
                            (t: any) => t && typeof t === "object",
                        );
                        if (!children.length) {
                            return null;
                        }
                        return (
                            <div key={g.title ?? gi}>
                                {g.title ? (
                                    <div className="tags-group-title">{g.title}</div>
                                ) : null}
                                <div className="tags-group-chips">
                                    {children.map((tag: any, idx: number) => (
                                        <TagChip
                                            key={`${gi}-${idx}`}
                                            tag={tag}
                                            activeTag={activeTag}
                                            onPick={onPick}
                                        />
                                    ))}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>,
        document.body,
    );
}

function TagChip({
    tag,
    activeTag,
    onPick,
}: {
    tag: any;
    activeTag: any;
    onPick: (tag: any) => void;
}) {
    return (
        <span
            className={`sheet-tag ${activeTag === tag ? "active" : ""}`}
            onClick={() => onPick(tag)}
        >
            {tag.title}
        </span>
    );
}
