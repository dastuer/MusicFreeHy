import { useRef, useState } from "react";
import SettingsSubPage from "@/pages/settings/subPage";
import { navigate } from "@/core/router";
import { showToast, openSingleSelect, openPrompt } from "@/core/uiAtoms";
import {
    exportBackupToLocal,
    importBackupFromLocal,
    importBackupFromUrl,
    exportBackupToWebdav,
    importBackupFromWebdav,
    getResumeMode,
    setResumeMode,
    RESUME_MODE_OPTIONS,
    describeResumeSummary,
    type ResumeMode,
    type IResumeSummary,
} from "@/core/backup";

/**
 * 备份与恢复（参考 MusicFree 移动端 backupSetting 分区）：
 * 恢复方式 / 本地备份（备份到本地、从本地文件恢复、从远程URL中恢复）/ WebDAV。
 * 备份数据的组装与恢复逻辑在 core/backup.ts，与 MusicFreeDesktop 互通，此处只做交互。
 */
export default function BackupRestorePage() {
    const [resumeMode, setResumeModeState] = useState<ResumeMode>(getResumeMode());
    const [localSummary, setLocalSummary] = useState("");
    const [webdavSummary, setWebdavSummary] = useState("");
    const fileRef = useRef<HTMLInputElement | null>(null);

    const pickResumeMode = () =>
        openSingleSelect({
            title: "恢复方式",
            options: RESUME_MODE_OPTIONS.map((m) => ({
                value: m.value,
                label: m.label,
                desc: m.desc,
            })),
            value: resumeMode,
            onSelect: (v) => {
                setResumeModeState(v as ResumeMode);
                setResumeMode(v as ResumeMode);
            },
        });

    const doExport = async () => {
        showToast("正在备份中…");
        const res = await exportBackupToLocal();
        if (res.success) {
            showToast(`备份成功（${res.sizeText}）`);
        } else {
            showToast(res.message ?? "备份失败");
        }
    };

    const doImport = async (file: File) => {
        showToast("正在恢复中…");
        try {
            const { summary }: { summary: IResumeSummary } =
                await importBackupFromLocal(file);
            setLocalSummary(describeResumeSummary(summary));
            showToast("恢复成功");
        } catch (e: any) {
            showToast(e?.message ?? "恢复失败");
        }
    };

    const doImportFromUrl = () =>
        openPrompt({
            title: "从远程URL中恢复",
            placeholder: "输入以json或txt结尾的URL",
            onConfirm: async (text) => {
                const url = text.trim();
                if (!url.endsWith(".json") && !url.endsWith(".txt")) {
                    showToast("无效的URL");
                    return;
                }
                showToast("正在恢复中…");
                try {
                    const { summary } = await importBackupFromUrl(url);
                    setLocalSummary(describeResumeSummary(summary));
                    showToast("恢复成功");
                } catch (e: any) {
                    showToast(e?.message ?? "恢复失败");
                }
            },
        });

    const doBackupToWebdav = async () => {
        showToast("正在备份中…");
        try {
            const res = await exportBackupToWebdav();
            showToast(`备份成功，已上传到 ${res.remotePath ?? "云端"}`, 3200);
        } catch (e: any) {
            showToast(e?.message ?? "备份失败");
        }
    };

    const doResumeFromWebdav = async () => {
        showToast("正在恢复中…");
        try {
            const { summary, remotePath } = await importBackupFromWebdav();
            setWebdavSummary(describeResumeSummary(summary));
            showToast(`恢复成功，来源 ${remotePath ?? "云端"}`, 3200);
        } catch (e: any) {
            showToast(e?.message ?? "恢复失败");
        }
    };

    return (
        <SettingsSubPage title="备份与恢复">
            <div className="settings-group">
                <div className="settings-group-title">备份与恢复</div>
                <div className="settings-row" onClick={pickResumeMode}>
                    <span className="settings-row-label">恢复方式</span>
                    <span className="settings-value">
                        {RESUME_MODE_OPTIONS.find((m) => m.value === resumeMode)?.label}
                    </span>
                    <span className="settings-value">›</span>
                </div>
            </div>

            <div className="settings-group">
                <div className="settings-group-title">本地备份</div>
                <div className="settings-row" onClick={doExport}>
                    <span className="settings-row-label">备份到本地</span>
                    <span className="settings-value">导出</span>
                </div>
                <div className="settings-row" onClick={() => fileRef.current?.click()}>
                    <span className="settings-row-label">
                        从本地文件恢复
                        {localSummary && <div className="settings-row-desc">{localSummary}</div>}
                    </span>
                    <span className="settings-value">选择文件</span>
                    <input
                        ref={fileRef}
                        type="file"
                        accept=".json,application/json"
                        style={{ display: "none" }}
                        onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) {
                                doImport(f);
                            }
                            e.target.value = "";
                        }}
                    />
                </div>
                <div className="settings-row" onClick={doImportFromUrl}>
                    <span className="settings-row-label">从远程URL中恢复</span>
                    <span className="settings-value">›</span>
                </div>
            </div>

            <div className="settings-group">
                <div className="settings-group-title">WebDAV</div>
                <div className="settings-row" onClick={() => navigate("settingsWebdav")}>
                    <span className="settings-row-label">WebDAV 设置</span>
                    <span className="settings-value">›</span>
                </div>
                <div className="settings-row" onClick={doBackupToWebdav}>
                    <span className="settings-row-label">备份到 WebDAV</span>
                    <span className="settings-value">上传</span>
                </div>
                <div className="settings-row" onClick={doResumeFromWebdav}>
                    <span className="settings-row-label">
                        从 WebDAV 恢复
                        {webdavSummary && (
                            <div className="settings-row-desc">{webdavSummary}</div>
                        )}
                    </span>
                    <span className="settings-value">下载</span>
                </div>
            </div>
        </SettingsSubPage>
    );
}
