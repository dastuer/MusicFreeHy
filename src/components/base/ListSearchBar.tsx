import { useEffect, useRef, useState } from "react";
import { useBackLayer } from "@/core/systemBack";
import { IconClose, IconSearch } from "./Icons";
import type { ListSearch } from "@/hooks/useListSearch";

/**
 * 列表页局部搜索框：覆盖在页面顶栏上（CSS 负 margin 上移叠住 sub-header），
 * 聚焦时占满导航栏；失焦后搜索框保留（过滤继续生效），
 * 点右侧「取消」或系统返回才退出并还原顶栏与列表。
 * 自带清空与「无结果」空态。
 */
export default function ListSearchBar({
    search,
    placeholder = "搜索歌曲 / 歌手 / 专辑",
}: {
    search: ListSearch;
    placeholder?: string;
}) {
    const inputRef = useRef<HTMLInputElement | null>(null);
    // 返回层注册推迟一拍：本组件挂载即「打开态」，而 StrictMode 的挂载→卸载→重挂载
    // 会让首次卸载的 history.back() 误弹重挂载压入的记录，历史错位会把页面弹回 about:blank
    const [backReady, setBackReady] = useState(false);

    // 等吸顶定位与页面进入动画稳定后再聚焦抬键盘，避免键盘顶飞首帧布局
    useEffect(() => {
        const t = setTimeout(() => inputRef.current?.focus(), 150);
        return () => clearTimeout(t);
    }, []);

    useEffect(() => {
        const t = setTimeout(() => setBackReady(true), 0);
        return () => clearTimeout(t);
    }, []);

    useBackLayer(backReady, "list-search", search.close);

    return (
        <>
            <div className="list-search-bar">
                <div className="search-input-wrap">
                    <IconSearch size={16} />
                    <input
                        ref={inputRef}
                        value={search.query}
                        placeholder={placeholder}
                        onChange={(e) => search.setQuery(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                // 搜索键即收起键盘：过滤结果保留，搜索框不退出
                                (e.target as HTMLInputElement).blur();
                            }
                        }}
                        enterKeyHint="search"
                    />
                    {search.query && (
                        <button
                            className="ls-clear"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => search.setQuery("")}
                            title="清空"
                        >
                            <IconClose size={12} />
                        </button>
                    )}
                </div>
                <button className="ls-cancel" onClick={search.close}>
                    取消
                </button>
            </div>
            {search.active && !search.matchCount && (
                <div className="empty-tip">没有找到「{search.query.trim()}」相关的歌曲</div>
            )}
        </>
    );
}
