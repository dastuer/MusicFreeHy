/**
 * 音乐列表加载骨架屏：占位行与 music-row 同排版（序号列 / 44px 封面 / 两行文字），
 * 加载完成后无缝替换，不会跳动。
 */
export default function MusicListSkeleton({
    rows = 10,
    showIndex = true,
}: {
    rows?: number;
    showIndex?: boolean;
}) {
    return (
        <div className="music-list" aria-hidden>
            {Array.from({ length: rows }, (_, i) => (
                <div key={i} className="music-row skeleton-row">
                    {showIndex ? (
                        <div className="music-row-index">
                            <div className="skeleton-bone sk-index" />
                        </div>
                    ) : null}
                    <div className="skeleton-bone sk-cover" />
                    <div className="skeleton-row-lines">
                        <div className="skeleton-bone sk-title" />
                        <div className="skeleton-bone sk-sub" />
                    </div>
                </div>
            ))}
        </div>
    );
}
