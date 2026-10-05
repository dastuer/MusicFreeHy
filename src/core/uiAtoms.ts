import { atom, getDefaultStore } from "jotai";
import { atomWithReset } from "jotai/utils";

/** ---------- UI 全局状态 ---------- */

/** 正在播放全屏浮层 */
export const nowPlayingOpenAtom = atom(false);
/** 播放队列抽屉 */
export const queueOpenAtom = atom(false);
/** 发现页内部标签 */
export const homeTabAtom = atom<"recommend" | "sheets" | "toplist">("recommend");
/** 全局侧边栏抽屉（发现 / 我的页左上角入口） */
export const drawerOpenAtom = atom(false);

export function openDrawer() {
    getDefaultStore().set(drawerOpenAtom, true);
}

export function closeDrawer() {
    getDefaultStore().set(drawerOpenAtom, false);
}

/** ---------- Toast ---------- */

export interface IToastItem {
    id: number;
    content: string;
}

const toastSeed = { current: 0 };

export const toastsAtom = atom<IToastItem[]>([]);

export function showToast(content: string, duration = 2400) {
    const store = getDefaultStore();
    const id = ++toastSeed.current;
    store.set(toastsAtom, [...store.get(toastsAtom), { id, content }]);
    setTimeout(() => {
        store.set(
            toastsAtom,
            store.get(toastsAtom).filter((it) => it.id !== id),
        );
    }, duration);
}

/** ---------- 歌曲操作菜单（长按 / 更多按钮弹出） ---------- */

export interface IMusicAction {
    label: string;
    danger?: boolean;
    onClick: () => void;
}

export interface IMusicActionState {
    musicItem: IMusic.IMusicItem;
    actions: IMusicAction[];
    /** 顶部标题覆盖（歌单等非歌曲对象复用此面板时使用） */
    title?: string;
    subtitle?: string;
}

export const musicActionAtom = atomWithReset<IMusicActionState | null>(null);

export function openMusicActions(state: IMusicActionState) {
    getDefaultStore().set(musicActionAtom, state);
}

export function closeMusicActions() {
    getDefaultStore().set(musicActionAtom, null);
}

/** ---------- 添加到歌单面板 ---------- */

export interface IAddToSheetState {
    musicItems: IMusic.IMusicItem[];
}

export const addToSheetAtom = atomWithReset<IAddToSheetState | null>(null);

export function openAddToSheet(musicItems: IMusic.IMusicItem[]) {
    getDefaultStore().set(addToSheetAtom, { musicItems });
}

export function closeAddToSheet() {
    getDefaultStore().set(addToSheetAtom, null);
}

/** ---------- 输入对话框（新建/重命名歌单等） ---------- */

export interface IPromptState {
    title: string;
    placeholder?: string;
    defaultValue?: string;
    confirmText?: string;
    onConfirm: (value: string) => void;
}

export const promptAtom = atomWithReset<IPromptState | null>(null);

export function openPrompt(state: IPromptState) {
    getDefaultStore().set(promptAtom, state);
}

export function closePrompt() {
    getDefaultStore().set(promptAtom, null);
}

/** ---------- 音源设置面板（我的页 / 首页侧边栏统一入口） ---------- */

export const sourceSelectOpenAtom = atom(false);

export function openSourceSelect() {
    getDefaultStore().set(sourceSelectOpenAtom, true);
}

export function closeSourceSelect() {
    getDefaultStore().set(sourceSelectOpenAtom, false);
}

/** ---------- 定时关闭面板（侧边栏入口） ---------- */

export const sleepTimerOpenAtom = atom(false);

export function openSleepTimer() {
    getDefaultStore().set(sleepTimerOpenAtom, true);
}

export function closeSleepTimer() {
    getDefaultStore().set(sleepTimerOpenAtom, false);
}

/** ---------- 歌词翻译显示（播放页双行渲染，设置页开关） ---------- */

export const lyricTranslationAtom = atom(
    localStorage.getItem("lyricShowTranslation") !== "false",
);

export function setLyricTranslation(enabled: boolean) {
    localStorage.setItem("lyricShowTranslation", String(enabled));
    getDefaultStore().set(lyricTranslationAtom, enabled);
}

/** ---------- 单选浮窗（设置等多选一项统一交互） ---------- */

export interface ISingleSelectOption {
    value: string;
    label: string;
    desc?: string;
}

export interface ISingleSelectState {
    /** 标题；不传则不渲染头部，直接展示选项 */
    title?: string;
    subtitle?: string;
    options: ISingleSelectOption[];
    /** 当前选中值，浮窗内打勾展示 */
    value?: string;
    onSelect: (value: string) => void;
}

export const singleSelectAtom = atomWithReset<ISingleSelectState | null>(null);

export function openSingleSelect(state: ISingleSelectState) {
    getDefaultStore().set(singleSelectAtom, state);
}

export function closeSingleSelect() {
    getDefaultStore().set(singleSelectAtom, null);
}
