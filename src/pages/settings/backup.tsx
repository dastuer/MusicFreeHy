import { useRef, useState } from "react";
import SettingsSubPage from "./subPage";
import {
    exportBackupToLocal,
    importBackupFromLocal,
    getResumeMode,
    setResumeMode,
    RESUME_MODE_OPTIONS,
    getBackupCounts,
    describeResumeSummary,
    type ResumeMode,
    type IResumeSummary,
} from "@/core/backup";
import { showToast, openSingleSelect } from "@/core/uiAtoms";

/** 备份与恢复二级页：本地导出 / 恢复 / 恢复模式（与 MusicFreeDesktop 互通） */
export default function SettingsBackupPage() {
    const [resumeMode, setResumeModeState] = useState<ResumeMode>(getResumeMode());
    const [counts, setCounts] = useState("");
    const [resumeSummary, setResumeSummary] = useState("");
    const fileRef = useRef<HTMLInputElement | null>(null);

    const pickResumeMode = () =>
        openSingleSelect({
            title: "恢复模式",
            subtitle: "恢复备份时如何处理本机已有数据",
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
        const res = await exportBackupToLocal();
        if (res.success) {
            showToast(`备份已导出（${res.sizeText}）`);
        } else {
            showToast(res.message ?? "导出失败");
        }
    };

    const doImport = async (file: File) => {
        try {
            const { summary }: { summary: IResumeSummary } = await importBackupFromLocal(file);
            setResumeSummary(describeResumeSummary(summary));
            showToast("备份恢复完成");
            const c = await getBackupCounts();
            setCounts(`${c.sheets} 个歌单 · ${c.songs} 首歌 · ${c.plugins} 个插件`);
        } catch (e: any) {
            showToast(e?.message ?? "恢复失败");
        }
    };

    return (
        <SettingsSubPage title="备份与恢复">
            <div className="settings-group">
                <div className="settings-group-title">本地备份（与 MusicFreeDesktop 互通）</div>
                <div className="settings-row" onClick={doExport}>
                    <span className="settings-row-label">
                        导出备份
                        <div className="settings-row-desc">导出为 .json 文件，可在桌面端恢复</div>
                    </span>
                    <span className="settings-value">导出</span>
                </div>
                <div className="settings-row" onClick={() => fileRef.current?.click()}>
                    <span className="settings-row-label">
                        恢复备份
                        {resumeSummary && (
                            <div className="settings-row-desc">{resumeSummary}</div>
                        )}
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
            </div>

            <div className="settings-group">
                <div className="settings-group-title">恢复模式</div>
                <div className="settings-row" onClick={pickResumeMode}>
                    <span className="settings-row-label">
                        恢复时如何处理本机数据
                        <div className="settings-row-desc">
                            {RESUME_MODE_OPTIONS.find((m) => m.value === resumeMode)?.desc}
                        </div>
                    </span>
                    <span className="settings-value">
                        {RESUME_MODE_OPTIONS.find((m) => m.value === resumeMode)?.label}
                    </span>
                    <span className="settings-value">›</span>
                </div>
                {counts && (
                    <div className="settings-tip" style={{ padding: "0 14px 12px" }}>
                        当前数据：{counts}
                    </div>
                )}
            </div>
        </SettingsSubPage>
    );
}
