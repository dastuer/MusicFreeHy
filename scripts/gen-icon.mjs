/**
 * 生成应用图标（纯 Node，无第三方依赖）。
 * 源图标：assets/logo.png —— 与 MusicFreeDesktop 同一只「戴耳机的猫」，
 * 由脚本解码后缩放，输出 web/PWA 图标与 Capacitor 启动图。
 * （原生 App 图标由 gen:icons 里的 npx capacitor-assets generate 继续用本目录资源生成）
 */
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (const byte of buf) {
        c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y += 1) {
        raw[y * (stride + 1)] = 0;
        rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type RGBA
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

/** 解码 8-bit 非隔行 PNG（灰度/RGB/灰度+alpha/RGBA），返回 { width, height, rgba } */
function decodePng(buf) {
    if (buf.readUInt32BE(0) !== 0x89504e47) {
        throw new Error("不是有效的 PNG 文件");
    }
    let off = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    const idat = [];
    while (off < buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString("ascii", off + 4, off + 8);
        const data = buf.subarray(off + 8, off + 8 + len);
        if (type === "IHDR") {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
            interlace = data[12];
        } else if (type === "IDAT") {
            idat.push(data);
        } else if (type === "IEND") {
            break;
        }
        off += 12 + len;
    }
    if (bitDepth !== 8 || interlace !== 0) {
        throw new Error(`不支持的 PNG：bitDepth=${bitDepth} interlace=${interlace}`);
    }
    const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
    if (!channels) {
        throw new Error(`不支持的 PNG 颜色类型：${colorType}`);
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const pixels = Buffer.alloc(width * height * channels);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < height; y += 1) {
        const filter = raw[y * (stride + 1)];
        const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const cur = pixels.subarray(y * stride, (y + 1) * stride);
        for (let x = 0; x < stride; x += 1) {
            const a = x >= channels ? cur[x - channels] : 0;
            const b = prev[x];
            const c = x >= channels ? prev[x - channels] : 0;
            let v = line[x];
            switch (filter) {
                case 1:
                    v = (v + a) & 0xff;
                    break;
                case 2:
                    v = (v + b) & 0xff;
                    break;
                case 3:
                    v = (v + ((a + b) >> 1)) & 0xff;
                    break;
                case 4: {
                    const p = a + b - c;
                    const pa = Math.abs(p - a);
                    const pb = Math.abs(p - b);
                    const pc = Math.abs(p - c);
                    v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
                    break;
                }
                default:
                    break;
            }
            cur[x] = v;
        }
        prev = cur;
    }
    const rgba = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i += 1) {
        const o = i * 4;
        if (colorType === 6) {
            rgba[o] = pixels[o];
            rgba[o + 1] = pixels[o + 1];
            rgba[o + 2] = pixels[o + 2];
            rgba[o + 3] = pixels[o + 3];
        } else if (colorType === 2) {
            rgba[o] = pixels[i * 3];
            rgba[o + 1] = pixels[i * 3 + 1];
            rgba[o + 2] = pixels[i * 3 + 2];
            rgba[o + 3] = 255;
        } else if (colorType === 4) {
            rgba[o] = rgba[o + 1] = rgba[o + 2] = pixels[i * 2];
            rgba[o + 3] = pixels[i * 2 + 1];
        } else {
            rgba[o] = rgba[o + 1] = rgba[o + 2] = pixels[i];
            rgba[o + 3] = 255;
        }
    }
    return { width, height, rgba };
}

/** 面积平均缩放（预乘 alpha，避免圆角透明边缘出暗晕） */
function resizeImage(src, dstSize) {
    const { width: sw, height: sh, rgba } = src;
    const out = Buffer.alloc(dstSize * dstSize * 4);
    for (let dy = 0; dy < dstSize; dy += 1) {
        const y0 = Math.floor((dy * sh) / dstSize);
        const y1 = Math.max(y0 + 1, Math.floor(((dy + 1) * sh) / dstSize));
        for (let dx = 0; dx < dstSize; dx += 1) {
            const x0 = Math.floor((dx * sw) / dstSize);
            const x1 = Math.max(x0 + 1, Math.floor(((dx + 1) * sw) / dstSize));
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            let n = 0;
            for (let y = y0; y < y1; y += 1) {
                for (let x = x0; x < x1; x += 1) {
                    const i = (y * sw + x) * 4;
                    const al = rgba[i + 3] / 255;
                    r += rgba[i] * al;
                    g += rgba[i + 1] * al;
                    b += rgba[i + 2] * al;
                    a += al;
                    n += 1;
                }
            }
            const o = (dy * dstSize + dx) * 4;
            if (a > 0) {
                out[o] = Math.round(r / a);
                out[o + 1] = Math.round(g / a);
                out[o + 2] = Math.round(b / a);
                out[o + 3] = Math.round((a / n) * 255);
            }
        }
    }
    return { width: dstSize, height: dstSize, rgba: out };
}

const srcLogo = decodePng(fs.readFileSync(path.resolve("assets/logo.png")));

const outDir = path.resolve("public/icons");
fs.mkdirSync(outDir, { recursive: true });
for (const [name, size] of [
    ["icon-512.png", 512],
    ["icon-192.png", 192],
    ["apple-touch-icon.png", 180],
    ["icon-32.png", 32],
]) {
    const resized = resizeImage(srcLogo, size);
    fs.writeFileSync(path.join(outDir, name), encodePng(size, size, resized.rgba));
    console.log(`✓ ${name} (${size}x${size})`);
}

/** 启动图：暗底居中贴缩放后的 logo */
function drawSplash(size, bg, logoSize = 512) {
    const logo = resizeImage(srcLogo, logoSize);
    const rgba = Buffer.alloc(size * size * 4);
    const [bgR, bgG, bgB] = bg;
    const offset = Math.floor((size - logoSize) / 2);
    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            const idx = (y * size + x) * 4;
            const lx = x - offset;
            const ly = y - offset;
            let alpha = 0;
            let lr = 0;
            let lg = 0;
            let lb = 0;
            if (lx >= 0 && lx < logoSize && ly >= 0 && ly < logoSize) {
                const li = (ly * logoSize + lx) * 4;
                alpha = logo.rgba[li + 3] / 255;
                lr = logo.rgba[li];
                lg = logo.rgba[li + 1];
                lb = logo.rgba[li + 2];
            }
            rgba[idx] = Math.round(bgR * (1 - alpha) + lr * alpha);
            rgba[idx + 1] = Math.round(bgG * (1 - alpha) + lg * alpha);
            rgba[idx + 2] = Math.round(bgB * (1 - alpha) + lb * alpha);
            rgba[idx + 3] = 255;
        }
    }
    return encodePng(size, size, rgba);
}

const assetsDir = path.resolve("assets");
fs.mkdirSync(assetsDir, { recursive: true });
// Android 启动图按 2732 全尺寸出；iOS 竖屏用同图
fs.writeFileSync(path.join(assetsDir, "splash.png"), drawSplash(2732, [21, 21, 21]));
console.log("✓ assets/splash.png (2732x2732)");
