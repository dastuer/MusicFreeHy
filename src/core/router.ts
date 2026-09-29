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
    | "pluginManage"
    | "settings"
    | "settingsBackup"
    | "settingsWebdav"
    | "settingsProxy";

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
    const tab = store.get(activeTabAtom);
    const stacks = store.get(tabStacksAtom);
    const cur = stacks[tab];
    const newStack = [...cur.stack];
    newStack[cur.index] = { path, params };
    store.set(tabStacksAtom, { ...stacks, [tab]: { stack: newStack, index: cur.index } });
}

/** 返回上一页；已在栈底时返回 false */
export function goBack(): boolean {
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
    store.set(activeTabAtom, tab);
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
