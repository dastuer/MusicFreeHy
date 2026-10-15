/**
 * QuickJS 全局补丁（**必须是 nativeRuntimeEntry 的第一个 import**）
 *
 * ESM 的依赖按 import 出现顺序求值：axios/cheerio/crypto-js 这些依赖在**模块初始化阶段**
 * 就可能摸浏览器/Node 全局（例如 base64 解码写的是
 * `typeof atob == "function" ? atob(s) : typeof Buffer.from == "function" ? ...` ——
 * QuickJS 既没有 atob 也没有 Buffer，两条分支都会 ReferenceError，
 * 而 nativeRuntimeEntry 里的 polyfillGlobals() 还没轮到执行）。
 *
 * 所以把「必须先于依赖求值」的补丁单独放这里；运行期才用到的补丁
 * （URL / 定时器 / FormData…）留在 polyfillGlobals() 里即可。
 */

const g = globalThis as any;

if (typeof g.atob !== "function") {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    g.atob = (b64: string) => {
        const clean = String(b64).replace(/[^A-Za-z0-9+/=]/g, "");
        let out = "";
        for (let i = 0; i < clean.length; i += 4) {
            const c0 = chars.indexOf(clean[i]);
            const c1 = chars.indexOf(clean[i + 1] ?? "A");
            const c2 = chars.indexOf(clean[i + 2] ?? "");
            const c3 = chars.indexOf(clean[i + 3] ?? "");
            out += String.fromCharCode((c0 << 2) | ((c1 >> 4) & 0x3f));
            if (clean[i + 2] !== undefined && c2 >= 0) {
                out += String.fromCharCode(((c1 & 15) << 4) | ((c2 >> 2) & 0x3f));
            }
            if (clean[i + 3] !== undefined && c3 >= 0) {
                out += String.fromCharCode(((c2 & 3) << 6) | (c3 & 0x3f));
            }
        }
        return out;
    };
}

if (typeof g.btoa !== "function") {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    g.btoa = (input: string) => {
        const s = String(input);
        let out = "";
        for (let i = 0; i < s.length; i += 3) {
            const c0 = s.charCodeAt(i);
            const has1 = i + 1 < s.length;
            const has2 = i + 2 < s.length;
            const c1 = has1 ? s.charCodeAt(i + 1) : 0;
            const c2 = has2 ? s.charCodeAt(i + 2) : 0;
            if (c0 > 255 || (has1 && c1 > 255) || (has2 && c2 > 255)) {
                throw new Error("InvalidCharacterError: btoa 只支持 Latin1");
            }
            out += chars[c0 >> 2];
            out += chars[((c0 & 3) << 4) | (has1 ? c1 >> 4 : 0)];
            out += has1 ? chars[((c1 & 15) << 2) | (has2 ? c2 >> 6 : 0)] : "=";
            out += has2 ? chars[c2 & 63] : "=";
        }
        return out;
    };
}

/**
 * TextDecoder（QuickJS 没有）：插件与依赖（iconv-lite 分支、cheerio 的
 * decodeStream 回退、axios 的 responseType=arraybuffer 后处理）都可能摸它。
 * 只支持 utf-8 / utf8 / latin1 / ascii，其余 encoding 按 utf-8 解——
 * 音乐插件解析链基本不会用到 GBK 之类的服务端编码。
 * 放在 preload 里是因为依赖可能在模块初始化阶段就 `new TextDecoder()`。
 */
if (typeof g.TextDecoder !== "function") {
    const utf8Decode = (bytes: Uint8Array, fatal?: boolean): string => {
        let out = "";
        let i = 0;
        while (i < bytes.length) {
            const b0 = bytes[i++];
            if (b0 < 0x80) {
                out += String.fromCharCode(b0);
                continue;
            }
            if (b0 < 0xc2) {
                // 连续字节出现在首字节位置 = 非法序列
                if (fatal) throw new TypeError("TextDecoder: invalid utf-8");
                out += "\ufffd";
                continue;
            }
            if (b0 < 0xe0) {
                if (i >= bytes.length) {
                    if (fatal) throw new TypeError("TextDecoder: truncated utf-8");
                    out += "\ufffd";
                    break;
                }
                out += String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[i++] & 0x3f));
            } else if (b0 < 0xf0) {
                if (i + 1 >= bytes.length) {
                    if (fatal) throw new TypeError("TextDecoder: truncated utf-8");
                    out += "\ufffd";
                    break;
                }
                const b1 = bytes[i++];
                const b2 = bytes[i++];
                out += String.fromCharCode(
                    ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f),
                );
            } else if (b0 < 0xf5) {
                if (i + 2 >= bytes.length) {
                    if (fatal) throw new TypeError("TextDecoder: truncated utf-8");
                    out += "\ufffd";
                    break;
                }
                const b1 = bytes[i++];
                const b2 = bytes[i++];
                const b3 = bytes[i++];
                const cp =
                    ((b0 & 0x07) << 18) |
                    ((b1 & 0x3f) << 12) |
                    ((b2 & 0x3f) << 6) |
                    (b3 & 0x3f);
                if (cp > 0x10ffff) {
                    if (fatal) throw new TypeError("TextDecoder: out of range");
                    out += "\ufffd";
                    continue;
                }
                const adj = cp - 0x10000;
                out += String.fromCharCode(0xd800 + (adj >> 10), 0xdc00 + (adj & 0x3ff));
            } else {
                if (fatal) throw new TypeError("TextDecoder: invalid utf-8");
                out += "\ufffd";
            }
        }
        return out;
    };
    g.TextDecoder = class TextDecoderShim {
        encoding: string;
        private fatal: boolean;
        constructor(encoding?: string, options?: { fatal?: boolean }) {
            const label = String(encoding ?? "utf-8").toLowerCase().replace(/[_\s]/g, "-");
            this.encoding = label === "utf8" ? "utf-8" : label;
            this.fatal = !!options?.fatal;
        }
        decode(input?: any): string {
            if (input === undefined || input === null) {
                return "";
            }
            const bytes = input instanceof Uint8Array
                ? input
                : ArrayBuffer.isView?.(input)
                    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
                    : input instanceof ArrayBuffer
                        ? new Uint8Array(input)
                        : new Uint8Array(0);
            if (this.encoding === "latin1" || this.encoding === "ascii"
                || this.encoding === "iso-8859-1" || this.encoding === "binary") {
                let out = "";
                for (let i = 0; i < bytes.length; i++) {
                    out += String.fromCharCode(bytes[i]);
                }
                return out;
            }
            return utf8Decode(bytes, this.fatal);
        }
    };
}

/**
 * 最小 Buffer：只求「不 ReferenceError」+ 覆盖 base64/utf8 两个最常见用法。
 * 用到更复杂能力（Buffer.concat/alloc 等）的库在原生运行时本来也不该用。
 */
if (typeof g.Buffer !== "function") {
    g.Buffer = class BufferShim extends Uint8Array {
        static isBuffer(value: any): boolean {
            return value instanceof BufferShim;
        }

        static alloc(size: number): any {
            return new BufferShim(Math.max(0, size | 0));
        }

        toString(encoding?: string): string {
            if (encoding === "base64") {
                let bin = "";
                for (let i = 0; i < this.length; i++) {
                    bin += String.fromCharCode(this[i]);
                }
                return (globalThis as any).btoa(bin);
            }
            // 默认按 UTF-8 解（Buffer 语义），QuickJS 没有 TextDecoder
            let out = "";
            let i = 0;
            while (i < this.length) {
                const b0 = this[i++];
                if (b0 < 0x80) {
                    out += String.fromCharCode(b0);
                } else if (b0 < 0xe0 && i < this.length) {
                    out += String.fromCharCode(((b0 & 0x1f) << 6) | (this[i++] & 0x3f));
                } else if (b0 < 0xf0 && i + 1 < this.length) {
                    const b1 = this[i++];
                    const b2 = this[i++];
                    out += String.fromCharCode(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f));
                } else if (i + 2 < this.length) {
                    const b1 = this[i++];
                    const b2 = this[i++];
                    const b3 = this[i++];
                    const cp =
                        ((b0 & 0x07) << 18) |
                        ((b1 & 0x3f) << 12) |
                        ((b2 & 0x3f) << 6) |
                        (b3 & 0x3f);
                    const adj = cp - 0x10000;
                    out += String.fromCharCode(0xd800 + (adj >> 10), 0xdc00 + (adj & 0x3ff));
                }
            }
            return out;
        }
    };
    // from 的签名与 Uint8Array.from 冲突，绕开静态类型检查补上
    (g.Buffer as any).from = (input: any, encoding?: string): any => {
        if (input instanceof Uint8Array) {
            return new g.Buffer(input);
        }
        const text = String(input ?? "");
        if (encoding === "base64") {
            const bin = g.atob(text);
            const out = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) {
                out[i] = bin.charCodeAt(i);
            }
            return new g.Buffer(out);
        }
        const out = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) {
            out[i] = text.charCodeAt(i) & 0xff;
        }
        return new g.Buffer(out);
    };

}
