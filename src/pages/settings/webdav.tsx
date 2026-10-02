import { useState } from "react";
import SettingsSubPage from "./subPage";
import {
    getWebdavConfig,
    setWebdavConfig,
    testWebdav,
    getWebdavLastAt,
} from "@/core/dav";
import { showToast } from "@/core/uiAtoms";

/** WebDAV 设置：账号配置与连接测试；备份/恢复操作在「备份与恢复」页 */
export default function SettingsWebdavPage() {
    const [cfg, setCfg] = useState(getWebdavConfig());

    const update = (patch: Partial<typeof cfg>) => {
        // 显示用本地状态，避免 getWebdavConfig 的 trim 干扰输入（如末尾斜杠）
        setCfg((prev) => ({ ...prev, ...patch }));
        setWebdavConfig(patch);
    };

    const lastUp = getWebdavLastAt("upload");
    const lastDown = getWebdavLastAt("download");

    return (
        <SettingsSubPage title="WebDAV 设置">
            <div className="settings-group">
                <div className="settings-group-title">账号配置</div>
                <div className="settings-row">
                    <span className="settings-row-label">服务器地址</span>
                    <input
                        className="settings-input"
                        style={{ width: 150 }}
                        value={cfg.url}
                        placeholder="https://dav.jianguoyun.com/dav/"
                        onChange={(e) => update({ url: e.target.value })}
                    />
                </div>
                <div className="settings-row">
                    <span className="settings-row-label">账号</span>
                    <input
                        className="settings-input"
                        style={{ width: 150 }}
                        value={cfg.username}
                        onChange={(e) => update({ username: e.target.value })}
                    />
                </div>
                <div className="settings-row">
                    <span className="settings-row-label">应用密码</span>
                    <input
                        className="settings-input"
                        style={{ width: 150 }}
                        type="password"
                        value={cfg.password}
                        onChange={(e) => update({ password: e.target.value })}
                    />
                </div>
                <div className="settings-row">
                    <span className="settings-row-label">文件路径</span>
                    <input
                        className="settings-input"
                        style={{ width: 150 }}
                        value={cfg.filePath}
                        onChange={(e) => update({ filePath: e.target.value })}
                    />
                </div>
                <div className="settings-row">
                    <span className="settings-row-label">测试连接</span>
                    <span
                        className="settings-value"
                        onClick={async () => {
                            showToast("正在测试连接…");
                            const res = await testWebdav(getWebdavConfig());
                            showToast(res.ok ? "WebDAV 连接成功" : res.message);
                        }}
                    >
                        测试
                    </span>
                </div>
            </div>

            {(lastUp || lastDown) && (
                <div className="settings-group">
                    <div className="settings-tip" style={{ padding: "0 14px 12px" }}>
                        上次上传：{lastUp ? new Date(lastUp).toLocaleString() : "无"}
                        <br />
                        上次下载：{lastDown ? new Date(lastDown).toLocaleString() : "无"}
                    </div>
                </div>
            )}
        </SettingsSubPage>
    );
}
