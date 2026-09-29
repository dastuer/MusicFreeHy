import { atom, getDefaultStore, useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";

/**
 * 主题系统：CSS 变量 + data-theme 属性（与桌面端同一套 token）
 * 对齐网易云：亮色 #ec4141 品牌红，暗色 #ea3d3d。
 * 手机版默认暗色（参考网易云音乐手机版深色观感）。
 */

export type ThemeType = "light" | "dark";
export type ThemeSetting = ThemeType | "auto";

export const themeSettingAtom = atom<ThemeSetting>("dark");

export const lightTheme = {
    primary: "#ec4141",
    pageBackground: "#ffffff",
    sidebarBackground: "#f5f5f7",
    hoverBackground: "rgba(0,0,0,0.06)",
    activeBackground: "rgba(0,0,0,0.09)",
    text: "#333333",
    textSecondary: "#666666",
    textTertiary: "#999999",
    textPlaceholder: "#cccccc",
    divider: "rgba(0,0,0,0.09)",
    playerBarBackground: "#f5f5f7",
    mask: "rgba(0,0,0,0.4)",
    elevatedBackground: "#f7f7f8",
    cardBackground: "#f2f2f4",
};

export const darkTheme = {
    primary: "#ea3d3d",
    pageBackground: "#151515",
    sidebarBackground: "#101010",
    hoverBackground: "rgba(255,255,255,0.08)",
    activeBackground: "rgba(255,255,255,0.12)",
    text: "#e8e8e8",
    textSecondary: "#a8a8a8",
    textTertiary: "#7c7c7c",
    textPlaceholder: "#5c5c5c",
    divider: "rgba(255,255,255,0.09)",
    playerBarBackground: "#0c0c0c",
    mask: "rgba(0,0,0,0.6)",
    elevatedBackground: "#1f1f1f",
    cardBackground: "#1c1c1e",
};

const themeVars: Record<keyof typeof lightTheme, string> = {
    primary: "--primary-color",
    pageBackground: "--page-bg",
    sidebarBackground: "--sidebar-bg",
    hoverBackground: "--hover-bg",
    activeBackground: "--active-bg",
    text: "--text-color",
    textSecondary: "--text-secondary",
    textTertiary: "--text-tertiary",
    textPlaceholder: "--text-placeholder",
    divider: "--divider",
    playerBarBackground: "--playerbar-bg",
    mask: "--mask",
    elevatedBackground: "--bg-elev",
    cardBackground: "--bg-card",
};

function applyTheme(type: ThemeType) {
    const theme = type === "dark" ? darkTheme : lightTheme;
    (Object.keys(themeVars) as (keyof typeof lightTheme)[]).forEach((key) => {
        document.documentElement.style.setProperty(themeVars[key], theme[key]);
    });
    document.documentElement.dataset.theme = type;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
        meta.setAttribute(
            "content",
            type === "dark" ? darkTheme.pageBackground : lightTheme.pageBackground,
        );
    }
}

function resolveTheme(setting: ThemeSetting): ThemeType {
    if (setting !== "auto") return setting;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function useThemeSetup() {
    const setThemeSetting = useSetAtom(themeSettingAtom);

    useEffect(() => {
        const saved = (localStorage.getItem("theme") as ThemeSetting) || "dark";
        setThemeSetting(saved);
        applyTheme(resolveTheme(saved));

        const media = window.matchMedia("(prefers-color-scheme: dark)");
        const handler = () => {
            if (localStorage.getItem("theme") === "auto") {
                applyTheme(media.matches ? "dark" : "light");
            }
        };
        media.addEventListener("change", handler);
        return () => media.removeEventListener("change", handler);
    }, [setThemeSetting]);
}

export function setTheme(setting: ThemeSetting): ThemeType {
    localStorage.setItem("theme", setting);
    getDefaultStore().set(themeSettingAtom, setting);
    const resolved = resolveTheme(setting);
    applyTheme(resolved);
    return resolved;
}

export function useThemeSetting() {
    return useAtomValue(themeSettingAtom);
}
