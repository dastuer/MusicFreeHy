import { useEffect, useState } from "react";
import { goBack } from "@/core/router";
import { tryPluginMethod } from "@/core/pluginUtils";
import { pickSourcePlugins, useGlobalSource } from "@/core/mediaSource";
import { getPlugins } from "@/core/ipc";
import { navigate } from "@/core/router";
import Cover from "@/components/base/Cover";
import Spinner from "@/components/base/Spinner";
import { IconBack, IconHeadphone } from "@/components/base/Icons";
import { formatPlayCount } from "@/core/utils";

/** 排行榜独立入口页（发现页快捷入口跳转） */

export default function TopListPage() {
    const [plugins, setPlugins] = useState<any[] | null>(null);
    const sourceHash = useGlobalSource();
    const [groups, setGroups] = useState<{ title: string; data: IMusic.IMusicSheetItemBase[] }[]>(
        [],
    );
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        getPlugins().then(setPlugins);
    }, []);

    useEffect(() => {
        if (!plugins) {
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(null);
        (async () => {
            const candidates = pickSourcePlugins(plugins, "getTopLists", sourceHash);
            const res = await tryPluginMethod<any>(candidates, "getTopLists");
            if (cancelled) {
                return;
            }
            const raw = res?.data;
            const normalized: { title: string; data: IMusic.IMusicSheetItemBase[] }[] = [];
            if (Array.isArray(raw)) {
                const flat: IMusic.IMusicSheetItemBase[] = [];
                for (const g of raw) {
                    if (Array.isArray(g?.data)) {
                        normalized.push({ title: g.title ?? "榜单", data: g.data });
                    } else if (g?.id !== undefined) {
                        flat.push(g);
                    }
                }
                if (!normalized.length && flat.length) {
                    normalized.push({ title: "榜单", data: flat });
                }
            }
            setGroups(normalized);
            if (!normalized.length) {
                setError(candidates.length ? "榜单加载失败，试试切换音源" : "还没有支持排行榜的音源");
            }
            setLoading(false);
        })();
        return () => {
            cancelled = true;
        };
    }, [plugins, sourceHash]);

    return (
        <div className="page">
            <div className="sub-header">
                <button className="icon-btn" onClick={() => goBack()}>
                    <IconBack size={22} />
                </button>
                <span className="sub-header-title">排行榜</span>
            </div>
            {error ? (
                <div className="error-tip">{error}</div>
            ) : loading ? (
                <div className="loading-tip loading-spin" style={{ paddingTop: 60 }}>
                    <Spinner size={20} />
                    加载中…
                </div>
            ) : (
                groups.map((g, gi) => (
                    <div key={gi}>
                        {g.title && (
                            <div
                                className="section-title"
                                style={{ padding: "14px 16px 6px", fontSize: 15 }}
                            >
                                {g.title}
                            </div>
                        )}
                        <div className="hscroll">
                            {g.data.map((it) => (
                                <div
                                    key={`${it.platform}-${it.id}`}
                                    className="sheet-card-h"
                                    onClick={() => navigate("topListDetail", { topListItem: it })}
                                >
                                    <Cover src={it.artwork} radius={12} className="sheet-grid-cover">
                                        <span className="card-playcount">
                                            <IconHeadphone size={11} />
                                            {formatPlayCount(it.playCount)}
                                        </span>
                                    </Cover>
                                    <div className="card-title">{it.title}</div>
                                </div>
                            ))}
                        </div>
                    </div>
                ))
            )}
        </div>
    );
}
