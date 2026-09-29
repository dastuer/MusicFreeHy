import type { ReactNode } from "react";
import { goBack } from "@/core/router";
import { IconBack } from "@/components/base/Icons";

/** 设置二级页外壳：返回栏 + 内容区 */
export default function SettingsSubPage({
    title,
    children,
}: {
    title: string;
    children: ReactNode;
}) {
    return (
        <div className="page">
            <div className="sub-header">
                <button className="icon-btn" onClick={() => goBack()}>
                    <IconBack size={22} />
                </button>
                <span className="sub-header-title">{title}</span>
                <span style={{ width: 44 }} />
            </div>
            {children}
        </div>
    );
}
