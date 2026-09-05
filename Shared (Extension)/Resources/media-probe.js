import { classifyMedia } from "./core.js";

const SNIFF_BYTES = 64 * 1024;

function sniffMediaType(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || 0);
    if (!bytes.byteLength) return "unknown";
    const prefix = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.byteLength, SNIFF_BYTES))).replace(/^\uFEFF/, "").trimStart();
    if (prefix.startsWith("#EXTM3U")) return "hls";
    if (bytes.byteLength >= 8 && ["ftyp", "styp", "moov", "moof"].includes(String.fromCharCode(...bytes.slice(4, 8)))) return "mp4";
    if (bytes.byteLength >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "webm";
    if (bytes.byteLength >= 3 && String.fromCharCode(...bytes.slice(0, 3)) === "FLV") return "flv";
    if (bytes.byteLength >= 3 && String.fromCharCode(...bytes.slice(0, 3)) === "ID3") return "mp3";
    if (bytes.byteLength >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return "aac";
    if (bytes[0] === 0x47 && (bytes.byteLength < 189 || bytes[188] === 0x47)) return "ts";
    return "unknown";
}

async function firstResponseBytes(response) {
    if (!response.body?.getReader) return new Uint8Array((await response.arrayBuffer()).slice(0, SNIFF_BYTES));
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        while (size < SNIFF_BYTES) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = value.slice(0, SNIFF_BYTES - size);
            chunks.push(chunk);
            size += chunk.byteLength;
        }
    } finally {
        await reader.cancel().catch(() => {});
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
}

async function request(url, options, fetchImpl, signal) {
    try { return await fetchImpl(url, { credentials: "include", cache: "no-store", redirect: "follow", signal, ...options }); }
    catch { return null; }
}

export async function identifyMediaCandidate(candidate, fetchImpl = globalThis.fetch) {
    const knownType = candidate.type && candidate.type !== "unknown" ? candidate.type : classifyMedia(candidate.url, candidate.mime);
    if (knownType !== "unknown") return { ...candidate, type: knownType };
    const trustedMediaKind = ["video", "audio"].includes(candidate.mediaKind) ? candidate.mediaKind : "";
    const fallback = () => trustedMediaKind ? { ...candidate, type: "unknown", mediaKind: trustedMediaKind, unverified: true } : null;
    if (!fetchImpl || (!trustedMediaKind && !["player", "element", "source"].includes(candidate.source))) return fallback();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
        const head = await request(candidate.url, { method: "HEAD" }, fetchImpl, controller.signal);
        if (head?.ok) {
            const mime = head.headers.get("content-type") || "";
            const type = classifyMedia(head.url || candidate.url, mime);
            if (type !== "unknown") return { ...candidate, url: head.url || candidate.url, mime, type };
        }

        const response = await request(candidate.url, { method: "GET", headers: { Range: `bytes=0-${SNIFF_BYTES - 1}` } }, fetchImpl, controller.signal);
        if (!response?.ok) return fallback();
        const mime = response.headers.get("content-type") || "";
        const responseURL = response.url || candidate.url;
        const headerType = classifyMedia(responseURL, mime);
        if (headerType !== "unknown") {
            await response.body?.cancel?.().catch(() => {});
            return { ...candidate, url: responseURL, mime, type: headerType };
        }
        const type = sniffMediaType(await firstResponseBytes(response));
        return type === "unknown" ? fallback() : { ...candidate, url: responseURL, mime, type };
    } finally {
        clearTimeout(timeout);
    }
}
