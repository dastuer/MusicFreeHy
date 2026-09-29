import { useState } from "react";
import SettingsSubPage from "./subPage";
import {
    getWebdavConfig,
    setWebdavConfig,
    testWebdav,
    getWebdavLastAt,
} from "@/core/dav";
import {
    exportBackupToWebdav,
    importBackupFromWebdav,
    describeResumeSummary,
    type IResumeSummary,
} from "@/core/backup";
import { showToast } from "@/core/uiAtoms";

/** WebDAV 云备份二级页：与桌面端同账号互传 */
export default function SettingsWebdavPage() {
    const [cfg, setCfg] = useState(getWebdavConfig());
    const [resumeSummary, setResumeSummary] = useState("");

    const update = (patch: Partial<typeof cfg>) => {
        // 显示用本地状态，避免 getWebdavConfig 的 trim 干扰输入（如末尾斜杠）
        setCfg((prev) => ({ ...prev, ...patch }));
        setWebdavConfig(patch);
    };

    const lastUp = getWebdavLastAt("upload");
    const lastDown = getWebdavLastAt("download");

    return (
        <SettingsSubPage title="WebDAV 云备份">
            <div className="settings-group">
                <div className="settings-group-title">账号配置（与桌面端同账号互传）</div>
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
                    <span className="settings-row-label">
                        文件路径
                        <div className="settings-row-desc">
                            指向桌面端的备份文件即可互相同步
                        </div>
                    </span>
                    <input
                        className="settings-input"
                        style={{ width: 150 }}
                        value={cfg.filePath}
                        onChange={(e) => update({ filePath: e.target.value })}
                    />
                </div>
            </div>

            <div className="settings-group">
                <div className="settings-group-title">操作</div>
                <div
                    className="settings-row"
                    onClick={async () => {
                        showToast("正在测试连接…");
                        const res = await testWebdav(getWebdavConfig());
                        showToast(res.ok ? "WebDAV 连接成功" : res.message);
                    }}
                >
                    <span className="settings-row-label">
                        测试连接<div className="settings-row-desc">校验服务器地址与账号密码</div>
                    </span>
                    <span className="settings-value">测试</span>
                </div>
                <div
                    className="settings-row"
                    onClick={async () => {
                        showToast("正在备份到 WebDAV…");
                        const res = await exportBackupToWebdav();
                        if (res.success) {
                            showToast(`已备份到 ${res.remotePath ?? "远端"}`, 3200);
                        } else {
                            showToast(res.message ?? "备份失败");
                        }
                    }}
                >
                    <span className="settings-row-label">
                        备份到云端<div className="settings-row-desc">把本机歌单、插件等上传到 WebDAV</div>
                    </span>
                    <span className="settings-value">上传</span>
                </div>
                <div
                    className="settings-row"
                    onClick={async () => {
                        try {
                            showToast("正在从 WebDAV 恢复…");
                            const { summary, remotePath } = await importBackupFromWebdav();
                            setResumeSummary(describeResumeSummary(summary));
                            showToast(`已从 ${remotePath ?? "云端"} 恢复`, 3200);
                        } catch (e: any) {
                            showToast(e?.message ?? "恢复失败");
                        }
                    }}
                >
                    <span className="settings-row-label">
                        从云端恢复
                        {resumeSummary && <div className="settings-row-desc">{resumeSummary}</div>}
                    </span>
                    <span className="settings-value">下载</span>
                </div>
                {(lastUp || lastDown) && (
                    <div className="settings-tip">
                        上次上传：{lastUp ? new Date(lastUp).toLocaleString() : "无"}
                        <br />
                        上次下载：{lastDown ? new Date(lastDown).toLocaleString() : "无"}
                    </div>
                )}
            </div>
        </SettingsSubPage>
    );
}
