import { IconDiscover, IconMusic } from "@/components/base/Icons";
import { useActiveTab, switchTab, type TabId } from "@/core/router";

const TABS: { id: TabId; label: string; icon: (p: { size?: number }) => JSX.Element }[] = [
    { id: "discover", label: "发现", icon: IconDiscover },
    { id: "mine", label: "我的", icon: IconMusic },
];

export default function TabBar() {
    const active = useActiveTab();
    return (
        <nav className="tab-bar">
            {TABS.map((tab) => (
                <div
                    key={tab.id}
                    className={`tab-item ${active === tab.id ? "active" : ""}`}
                    onClick={() => switchTab(tab.id)}
                >
                    <span className="tab-icon">
                        <tab.icon size={22} />
                    </span>
                    {tab.label}
                </div>
            ))}
        </nav>
    );
}
