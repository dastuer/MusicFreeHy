import { useAtomValue } from "jotai";
import { musicActionAtom, closeMusicActions } from "@/core/uiAtoms";
import { useBackLayer } from "@/core/systemBack";

/** 歌曲长按/更多操作：底部弹出的动作面板（网易云 Pad 风格） */
export default function MusicActionSheet() {
    const state = useAtomValue(musicActionAtom);

    // 系统返回先收起面板
    useBackLayer(!!state, "music-actions", closeMusicActions);

    if (!state) {
        return null;
    }
    return (
        <div className="sheet-mask" onClick={() => closeMusicActions()}>
            <div className="action-sheet" onClick={(e) => e.stopPropagation()}>
                <div className="action-sheet-song">
                    <div className="action-sheet-song-title">
                        {state.title ?? state.musicItem.title}
                    </div>
                    <div className="action-sheet-song-artist">
                        {state.subtitle ?? state.musicItem.artist}
                    </div>
                </div>
                {state.actions.map((action, idx) => (
                    <button
                        key={idx}
                        className={`action-sheet-item ${action.danger ? "danger" : ""}`}
                        onClick={() => {
                            closeMusicActions();
                            action.onClick();
                        }}
                    >
                        {action.label}
                    </button>
                ))}
                <button className="action-sheet-item cancel" onClick={() => closeMusicActions()}>
                    取消
                </button>
            </div>
        </div>
    );
}
