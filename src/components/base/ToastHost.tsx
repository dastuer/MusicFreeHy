import { useAtomValue } from "jotai";
import { toastsAtom } from "@/core/uiAtoms";

/** 全局 Toast 宿主：顶部居中，自动消失 */
export default function ToastHost() {
    const toasts = useAtomValue(toastsAtom);
    if (!toasts.length) {
        return null;
    }
    return (
        <div className="toast-host">
            {toasts.map((t) => (
                <div key={t.id} className="toast-item">
                    {t.content}
                </div>
            ))}
        </div>
    );
}
