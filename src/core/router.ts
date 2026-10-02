import { atom, getDefaultStore, useAtomValue } from "jotai";

/**
 * 手机版栈式路由：底部 Tab 各自持有独立栈。
 * - navigate / goBack 作用于当前激活 Tab 的栈；
 * - switchTab 切换 Tab（保留各自栈，回到该 Tab 上次的位置）；
 * - 对外 API 与桌面/Pad 端 router.ts 同名同义，复用组件无需改动。
 */

export type RoutePath =
    | "home"
    | "search"
    | "sheetDetail"
    | "albumDetail"
    | "artistDetail"
    | "topList"
    | "topListDetail"
    | "myMusic"
    | "history"
    | "downloads"
    | "localMusic"
    | "pluginManage"
    | "settings"
    | "backupRestore"
    | "settingsWebdav"
    | "settingsProxy"
    | "folderSelect";

export type TabId = "discover" | "mine";

export const TAB_ROOT: Record<TabId, RoutePath> = {
    discover: "home",
    mine: "myMusic",
};

export interface IRoute {
    path: RoutePath;
    params: Record<string, any>;
}

interface ITabStack {
    stack: IRoute[];
    index: number;
}

const makeRoot = (tab: TabId): ITabStack => ({
    stack: [{ path: TAB_ROOT[tab], params: {} }],
    index: 0,
});

const tabStacksAtom = atom<Record<TabId, ITabStack>>({
    discover: makeRoot("discover"),
    mine: makeRoot("mine"),
});

const activeTabAtom = atom<TabId>("discover");

const store = getDefaultStore();

/** 导航到新页面（压栈，截断前进历史） */
export function navigate(path: RoutePath, params: Record<string, any> = {}) {
    pendingPush = true;
    const tab = store.get(activeTabAtom);
    const stacks = store.get(tabStacksAtom);
    const cur = stacks[tab];
    const newStack = cur.stack.slice(0, cur.index + 1);
    newStack.push({ path, params });
    store.set(tabStacksAtom, {
        ...stacks,
        [tab]: { stack: newStack, index: newStack.length - 1 },
    });
}

/** 替换当前页面 */
export function replaceCurrent(path: RoutePath, params: Record<string, any> = {}) {
    pendingPush = false;
    const tab = store.get(activeTabAtom);
    const stacks = store.get(tabStacksAtom);
    const cur = stacks[tab];
    const newStack = [...cur.stack];
    newStack[cur.index] = { path, params };
    store.set(tabStacksAtom, { ...stacks, [tab]: { stack: newStack, index: cur.index } });
}

/** 返回上一页；已在栈底时返回 false */
export function goBack(): boolean {
    pendingPush = false;
    const tab = store.get(activeTabAtom);
    const stacks = store.get(tabStacksAtom);
    const cur = stacks[tab];
    if (cur.index > 0) {
        store.set(tabStacksAtom, { ...stacks, [tab]: { ...cur, index: cur.index - 1 } });
        return true;
    }
    return false;
}

export function switchTab(tab: TabId) {
    pendingPush = false;
    store.set(activeTabAtom, tab);
}

/**
 * 一次性标记：刚发生 navigate 压栈且未被消费；goBack / switchTab / replaceCurrent
 * 都会立即作废它。供搜索页等区分「从导航入口新进」（需要自动聚焦抬键盘）与
 * 「返回 / 切 Tab 回到本页」（不打扰用户）。
 */
let pendingPush = false;

/** 读取并清除压栈标记，在目标页首次挂载时调用一次 */
export function consumePendingPush(): boolean {
    const pushed = pendingPush;
    pendingPush = false;
    return pushed;
}

export function useCurrentRoute(): IRoute {
    const tab = useAtomValue(activeTabAtom);
    const stacks = useAtomValue(tabStacksAtom);
    const cur = stacks[tab];
    return cur.stack[Math.min(cur.index, cur.stack.length - 1)] ?? { path: "home", params: {} };
}

export function useCanGoBack(): boolean {
    const tab = useAtomValue(activeTabAtom);
    const stacks = useAtomValue(tabStacksAtom);
    return stacks[tab].index > 0;
}

export function useActiveTab(): TabId {
    return useAtomValue(activeTabAtom);
}

/** 当前页面是否是所在 Tab 的根页面（决定底部 TabBar / 顶部返回栏的形态） */
export function useIsTabRoot(): boolean {
    const tab = useAtomValue(activeTabAtom);
    const stacks = useAtomValue(tabStacksAtom);
    const cur = stacks[tab];
    return cur.index === 0 && cur.stack[cur.index]?.path === TAB_ROOT[tab];
}
