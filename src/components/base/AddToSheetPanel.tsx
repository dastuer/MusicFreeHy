import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import {
    addToSheetAtom,
    closeAddToSheet,
    openPrompt,
    showToast,
} from "@/core/uiAtoms";
import {
    getUserSheets,
    addMusicToSheetMany,
    createSheet,
    ensureLikesSheet,
    sheetsVersionAtom,
    type IUserSheet,
} from "@/core/musicSheet";
import Cover from "./Cover";
import { IconPlus } from "./Icons";
import { useBackLayer } from "@/core/systemBack";

/** 「添加到歌单」底部面板：喜欢的音乐 + 用户歌单 + 新建 */
export default function AddToSheetPanel() {
    const state = useAtomValue(addToSheetAtom);
    const sheetsVersion = useAtomValue(sheetsVersionAtom);
    const [sheets, setSheets] = useState<IUserSheet[]>([]);

    // 系统返回先收起面板
    useBackLayer(!!state, "add-to-sheet", closeAddToSheet);

    useEffect(() => {
        if (state) {
            ensureLikesSheet();
            setSheets(getUserSheets());
        }
    }, [state, sheetsVersion]);

    if (!state) {
        return null;
    }

    const addTo = async (sheetId: string, title: string) => {
        const { added, skipped } = addMusicToSheetMany(sheetId, state.musicItems);
        closeAddToSheet();
        showToast(
            added
                ? `已添加到「${title}」${skipped ? `，${skipped} 首已存在` : ""}`
                : `歌曲已在「${title}」中`,
        );
    };

    return (
        <div className="sheet-mask" onClick={() => closeAddToSheet()}>
            <div className="add-sheet-panel" onClick={(e) => e.stopPropagation()}>
                <div className="add-sheet-header">添加到歌单</div>
                <div className="add-sheet-list">
                    {sheets.map((sheet) => (
                        <div
                            key={sheet.id}
                            className="add-sheet-row"
                            onClick={() => addTo(sheet.id, sheet.title)}
                        >
                            <Cover src={sheet.musicList[0]?.artwork} size={40} radius={6} />
                            <div className="add-sheet-row-info">
                                <div className="add-sheet-row-title">{sheet.title}</div>
                                <div className="add-sheet-row-sub">
                                    {sheet.musicList.length} 首
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
                <button
                    className="add-sheet-new"
                    onClick={() => {
                        openPrompt({
                            title: "新建歌单",
                            placeholder: "歌单标题",
                            confirmText: "创建",
                            onConfirm: (title) => {
                                const sheet = createSheet(title.trim() || "新建歌单");
                                addTo(sheet.id, sheet.title);
                            },
                        });
                    }}
                >
                    <IconPlus size={18} />
                    <span>新建歌单</span>
                </button>
            </div>
        </div>
    );
}
