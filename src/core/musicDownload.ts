import { atom, getDefaultStore } from "jotai";
import { TrackPlayerSingleton } from "./trackPlayer";
import { getProxyBase } from "./net";
import { b64urlEncode } from "./ipc";
import { showToast } from "./uiAtoms";

/**
 * 歌曲下载：音质选档 → 插件解析原始直链 → 拉成 blob → 浏览器通道存到本机
 * （与备份导出同一保存方式）。
 *
 * 解析复用播放器的 resolveMediaUrl：插件缺失/被禁用时能拿到同一套人话原因；
 * 拉流优先直连（CapacitorHttp 接管 fetch，无跨域限制、可带自定义请求头），
 * 失败再走伴生代理的 /media 转发流。
 */

/** 全局同一时间只跑一个下载任务；UI 用它显示进行中状态 */
export const downloadingAtom = atom(false);

let downloading = false;

/** 音质档位显示名 */
export const QUALITY_LABEL: Record<IMusic.IQualityKey, string> = {
    low: "流畅音质",
    standard: "标准音质",
    high: "极高音质",
    super: "无损音质",
};

/** 音质档位的短名（toast / 按钮用） */
export function qualityShortName(q: IMusic.IQualityKey) {
    return QUALITY_LABEL[q].replace("音质", "");
}

/** 音质描述里的文件大小：数字按字节格式化，字符串（"12.3MB"）原样展示 */
export function formatQualitySize(size?: string | number) {
    if (size === undefined || size === null || size === "") {
        return undefined;
    }
    if (typeof size === "number") {
        return size > 1024 * 1024
            ? `${(size / 1024 / 1024).toFixed(1)}MB`
            : `${Math.max(1, Math.round(size / 1024))}KB`;
    }
    return String(size);
}

function sanitizeFilename(name: string) {
    return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "music";
}

/** 扩展名：先看直链路径，再猜 content-type，兜底 mp3 */
function inferExt(url: string, contentType: string) {
    const m = url.split(/[?#]/)[0].match(/\.(mp3|flac|m4a|aac|wav|ogg|opus|ape|wma)$/i);
    if (m) {
        return m[1].toLowerCase();
    }
    const table: Record<string, string> = {
        "audio/mpeg": "mp3",
        "audio/mp3": "mp3",
        "audio/flac": "flac",
        "audio/x-flac": "flac",
        "audio/mp4": "m4a",
        "audio/x-m4a": "m4a",
        "audio/m4a": "m4a",
        "audio/aac": "aac",
        "audio/wav": "wav",
        "audio/x-wav": "wav",
        "audio/ogg": "ogg",
        "audio/opus": "opus",
    };
    return table[(contentType || "").split(";")[0].trim().toLowerCase()] ?? "mp3";
}

async function fetchBlob(url: string, headers?: Record<string, string>) {
    const resp = await fetch(url, headers && Object.keys(headers).length ? { headers } : undefined);
    if (!resp.ok) {
        throw new Error(`请求失败 (${resp.status})`);
    }
    return { blob: await resp.blob(), contentType: resp.headers.get("content-type") ?? "" };
}

/**
 * 下载一首歌。过程用 toast 播报（开始/完成/失败），返回结果供调用方补充处理。
 * @param quality 期望音质档；插件该档不可用时解析器会自动降档，完成提示里带实际档位
 */
export async function downloadMusic(
    musicItem: IMusic.IMusicItem,
    quality: IMusic.IQualityKey,
): Promise<{ ok: boolean; message?: string }> {
    if (downloading) {
        return { ok: false, message: "已有歌曲在下载中，请稍候" };
    }
    downloading = true;
    const store = getDefaultStore();
    store.set(downloadingAtom, true);
    showToast(`开始下载「${musicItem.title}」（${qualityShortName(quality)}）`, 3200);
    try {
        const res = await TrackPlayerSingleton.resolveMediaUrl(musicItem, quality);
        if (!res.ok) {
            showToast(res.reason, 3600);
            return { ok: false, message: res.reason };
        }

        const source = res.source ?? {};
        const rawUrl = source.url ?? res.src;
        const headers: Record<string, string> = { ...(source.headers ?? {}) };
        if (source.userAgent && !Object.keys(headers).some((h) => h.toLowerCase() === "user-agent")) {
            headers["User-Agent"] = source.userAgent;
        }

        let fetched: { blob: Blob; contentType: string };
        try {
            fetched = await fetchBlob(rawUrl, headers);
        } catch (e) {
            // 带自定义头的直链被跨域拦截（浏览器/开发者模式）时，走伴生代理的媒体转发流
            const proxyBase = getProxyBase();
            if (!proxyBase) {
                throw e;
            }
            const proxied = `${proxyBase}/media?u=${b64urlEncode(rawUrl)}&h=${b64urlEncode(
                JSON.stringify(headers),
            )}`;
            fetched = await fetchBlob(proxied);
        }

        const { blob, contentType } = fetched;
        const filename = `${sanitizeFilename(`${musicItem.artist} - ${musicItem.title}`)}.${inferExt(
            rawUrl,
            contentType,
        )}`;

        // 与备份导出同一保存通道：blob + <a download>
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // 大文件留给 WebView 一点读取余量，再释放引用
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);

        const sizeText =
            blob.size > 1024 * 1024
                ? `${(blob.size / 1024 / 1024).toFixed(1)}MB`
                : `${Math.max(1, Math.round(blob.size / 1024))}KB`;
        const actualQuality = res.quality ? qualityShortName(res.quality) : "默认";
        const message = `下载完成：${filename}（${actualQuality} · ${sizeText}）`;
        showToast(message, 3600);
        return { ok: true, message };
    } catch (e: any) {
        const message = e?.message ?? String(e);
        showToast(`下载失败：${message}`, 3600);
        return { ok: false, message };
    } finally {
        downloading = false;
        store.set(downloadingAtom, false);
    }
}
