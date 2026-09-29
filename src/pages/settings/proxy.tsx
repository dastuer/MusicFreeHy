import { useState } from "react";
import SettingsSubPage from "./subPage";
import { getProxyBase, setProxyBase, testProxy } from "@/core/net";
import { showToast } from "@/core/uiAtoms";

/** 伴生代理二级页（仅浏览器环境展示入口；App 环境无需代理） */
export default function SettingsProxyPage() {
    const [proxy, setProxy] = useState(getProxyBase());

    return (
        <SettingsSubPage title="伴生代理">
            <div className="settings-group">
                <div className="settings-group-title">代理地址</div>
                <div className="settings-row">
                    <input
                        className="settings-input"
                        style={{ flex: 1, width: "auto" }}
                        placeholder="http://192.168.x.x:7952"
                        value={proxy}
                        onChange={(e) => setProxy(e.target.value)}
                    />
                </div>
                <div className="settings-tip" style={{ padding: "2px 14px 12px" }}>
                    留空时自动使用内置代理（npm run dev / preview 自带，可解决跨域与 WebDAV
                    备份）；跨机访问可填 `npm run proxy` 的地址。App 无需代理
                </div>
            </div>

            <div className="settings-group">
                <div className="settings-row">
                    <button
                        className="settings-btn"
                        style={{ flex: 1 }}
                        onClick={async () => {
                            setProxyBase(proxy);
                            const res = await testProxy(proxy);
                            showToast(res.message);
                        }}
                    >
                        测试连接
                    </button>
                    <button
                        className="settings-btn primary"
                        style={{ flex: 1 }}
                        onClick={() => {
                            setProxyBase(proxy);
                            showToast("已保存");
                        }}
                    >
                        保存
                    </button>
                </div>
            </div>
        </SettingsSubPage>
    );
}
