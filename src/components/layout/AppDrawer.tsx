import { useState } from "react";
import { useAtomValue } from "jotai";
import { closeDrawer, drawerOpenAtom, openSourceSelect } from "@/core/uiAtoms";
import { navigate } from "@/core/router";
import { useBackLayer } from "@/core/systemBack";
import { IconDisc, IconPuzzle, IconSettings } from "@/components/base/Icons";
import logoUrl from "../../../assets/logo.png";

/**
 * 全局侧边栏抽屉：发现页 / 我的页左上角汉堡入口。
 * 聚合低频功能入口：音源、插件、设置。
 */
export default function AppDrawer() {
    const open = useAtomValue(drawerOpenAtom);
    const [closing, setClosing] = useState(false);

    // 系统返回先收起抽屉
    useBackLayer(open, "app-drawer", closeDrawer);

    // 先播放向左滑出的动画，再卸载并复位收起状态（组件常驻，状态要能反复用）
    const requestClose = () => {
        if (closing) {
            return;
        }
        setClosing(true);
        window.setTimeout(() => {
            setClosing(false);
            closeDrawer();
        }, 200);
    };

    if (!open) {
        return null;
    }

    return (
        <div
            className={`drawer-mask ${closing ? "closing" : ""}`}
            onClick={requestClose}
        >
            <div className="drawer" onClick={(e) => e.stopPropagation()}>
                <div className="drawer-title">
                    <img className="drawer-logo" src={logoUrl} alt="MusicFreeHy" />
                </div>
                <div
                    className="drawer-item"
                    onClick={() => {
                        requestClose();
                        // 等抽屉收起后再弹音源设置，避免两层遮罩叠加闪烁
                        window.setTimeout(openSourceSelect, 220);
                    }}
                >
                    <span className="d-icon">
                        <IconDisc size={20} />
                    </span>
                    音源
                </div>
                <div
                    className="drawer-item"
                    onClick={() => {
                        requestClose();
                        navigate("pluginManage");
                    }}
                >
                    <span className="d-icon">
                        <IconPuzzle size={20} />
                    </span>
                    插件
                </div>
                <div
                    className="drawer-item"
                    onClick={() => {
                        requestClose();
                        navigate("settings");
                    }}
                >
                    <span className="d-icon">
                        <IconSettings size={20} />
                    </span>
                    设置
                </div>
            </div>
        </div>
    );
}
