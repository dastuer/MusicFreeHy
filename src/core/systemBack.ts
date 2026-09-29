import { useEffect, useRef } from "react";
import { addNativeListener, callNativeMethod, isNative } from "./native";
import { goBack as goBackRoute } from "./router";

/**
 * 系统返回统一入口
 *
 * 触发来源有两类，最终都落到这套「浮层返回栈」上：
 *  - Android 返回键 / 全面屏返回手势：由 @capacitor/app 的 backButton 事件驱动；
 *  - iOS 侧滑返回 / 浏览器后退：WKWebView 的历史导航手势，表现为 popstate 事件。
 *
 * 返回时由内向外逐层消费，消费不掉才交给系统：
 *  1. 最上层的浮层（正在播放页、播放队列、操作面板、对话框）——只关浮层，应用原地停留；
 *  2. 应用内路由栈回退（详情页 → 上一页）；
 *  3. 都没有了：Android 把应用退到后台（音乐继续播放），不退出应用。
 *
 * iOS 侧滑要做成「返回」而不是退出应用，靠的是 history：每个浮层打开时压入一条
 * 记录（关闭时回退掉），所以侧滑永远有的可退；而最初那次页面加载记录之前没有历史，
 * 手势到那里就被系统拦住了，不可能滑出应用。
 */

interface IBackLayer {
    id: string;
    close: () => void;
    /** 这条浮层记录是否已经处理过（被系统返回吃掉，或由我们自己回退） */
    historyHandled: boolean;
}

/** 打开中的浮层栈，栈顶即最上层 */
const layers: IBackLayer[] = [];
/** 当前压在 history 里的浮层记录条数 */
let pushedCount = 0;
/** 我们自己发起、需要 popstate 忽略掉的回退次数 */
let selfPopCount = 0;

const HISTORY_FLAG = "__mfhBackLayer";

function pushHistoryEntry() {
    try {
        window.history.pushState({ [HISTORY_FLAG]: true }, "", window.location.href);
        pushedCount += 1;
    } catch (e) {
        console.warn("[back] 压入历史记录失败", e);
    }
}

/** 回退掉自己压入的一条记录（对应 popstate 会被 selfPopCount 吃掉） */
function popHistoryEntry() {
    if (pushedCount <= 0) {
        return;
    }
    pushedCount -= 1;
    selfPopCount += 1;
    window.history.back();
}

function onPopState() {
    // iOS 侧滑 / 浏览器后退：我们压入的那条记录被系统吃掉了
    if (selfPopCount > 0) {
        selfPopCount -= 1;
        return;
    }
    if (pushedCount > 0) {
        pushedCount -= 1;
    }
    const layer = layers.pop();
    if (!layer) {
        // 没有浮层可关：这条记录不是为浮层压入的（例如前进回到旧记录），无事可做
        return;
    }
    layer.historyHandled = true;
    layer.close();
}

/**
 * 注册一层返回处理（浮层打开时调用），返回解绑函数，交给 useEffect 清理
 * @param id 标识，便于排查问题
 * @param close 关闭该浮层的回调
 */
export function registerBackLayer(id: string, close: () => void): () => void {
    const layer: IBackLayer = { id, close, historyHandled: false };
    layers.push(layer);
    pushHistoryEntry();
    return () => {
        const index = layers.indexOf(layer);
        if (index >= 0) {
            layers.splice(index, 1);
        }
        if (!layer.historyHandled) {
            layer.historyHandled = true;
            popHistoryEntry();
        }
    };
}

/** React 写法：`open` 为真期间，该浮层占用一层返回 */
export function useBackLayer(open: boolean, id: string, close: () => void) {
    const closeRef = useRef(close);
    closeRef.current = close;
    useEffect(() => {
        if (!open) {
            return;
        }
        return registerBackLayer(id, () => closeRef.current());
    }, [open, id]);
}

/** 关闭最上层浮层；没有浮层时返回 false */
function closeTopLayer(): boolean {
    const layer = layers.pop();
    if (!layer) {
        return false;
    }
    // 历史记录在这里同步回退，组件卸载时的解绑不再重复处理
    layer.historyHandled = true;
    layer.close();
    popHistoryEntry();
    return true;
}

/**
 * 处理一次系统返回（Android 返回键 / 全面屏返回手势）
 * @returns 是否已被应用内消费；false 表示已退无可退，由调用方决定退到后台 / 退出
 */
export function handleSystemBack(): boolean {
    if (closeTopLayer()) {
        return true;
    }
    return goBackRoute();
}

/** 挂上全局返回监听（main.tsx 里调用一次） */
export function setupSystemBack() {
    window.addEventListener("popstate", onPopState);
    if (!isNative()) {
        return;
    }
    addNativeListener("App", "backButton", () => {
        if (handleSystemBack()) {
            return;
        }
        // 已经在应用最外层：退到后台（音乐继续播放），不退出应用
        void callNativeMethod("App", "minimizeApp").catch((e: any) =>
            console.warn("[back] 退到后台失败", e),
        );
    });
}
