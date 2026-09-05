const MEDIA_EXTENSION = /\.(m3u8|mp4|m4v|webm|flv|mp3|m4a|aac|mov|ts)(?:$|[?#])/i;

export function classifyMedia(url = "", mime = "") {
    const value = `${url} ${mime}`.toLowerCase();
    if (/\.m3u8(?:$|[?#\s])|mpegurl/.test(value)) return "hls";
    if (/\.mp4(?:$|[?#\s])|\.m4v(?:$|[?#\s])|video\/mp4/.test(value)) return "mp4";
    if (/\.webm(?:$|[?#\s])|video\/webm/.test(value)) return "webm";
    if (/\.flv(?:$|[?#\s])|video\/x-flv/.test(value)) return "flv";
    if (/\.mp3(?:$|[?#\s])|audio\/mpeg/.test(value)) return "mp3";
    if (/\.m4a(?:$|[?#\s])|audio\/mp4/.test(value)) return "m4a";
    if (/\.aac(?:$|[?#\s])|audio\/aac/.test(value)) return "aac";
    if (/\.mov(?:$|[?#\s])|video\/quicktime/.test(value)) return "mov";
    if (/\.ts(?:$|[?#\s])|video\/mp2t/.test(value)) return "ts";
    return "unknown";
}

export function looksLikeMedia(url = "", mime = "") {
    return MEDIA_EXTENSION.test(url) || /^(video|audio)\//i.test(mime) || /mpegurl/i.test(mime);
}

export function absoluteURL(value, base) {
    try {
        const url = new URL(value, base);
        if (!/^https?:$/.test(url.protocol)) return null;
        url.hash = "";
        return url.href;
    } catch {
        return null;
    }
}

export function candidateKey(candidate) {
    return `${candidate.url}|${candidate.width || 0}x${candidate.height || 0}`;
}

export function compactMediaURL(input = "") {
    try {
        const url = new URL(input);
        const segments = url.pathname.split("/").filter(Boolean);
        if (!segments.length) return url.hostname;
        const filename = decodeURIComponent(segments.at(-1));
        return segments.length > 1 ? `${url.hostname}/…/${filename}` : `${url.hostname}/${filename}`;
    } catch {
        const value = String(input);
        return value.length > 72 ? `${value.slice(0, 34)}…${value.slice(-30)}` : value;
    }
}

export function safeFilename(input = "video", extension = "") {
    let name = String(input)
        .normalize("NFKC")
        .replace(/[\\/:*?\"<>|\u0000-\u001f]/g, " ")
        .replace(/\s+/g, " ")
        .replace(/^\.+|\.+$/g, "")
        .trim()
        .slice(0, 180) || "video";
    const ext = extension.replace(/^\./, "").toLowerCase();
    if (ext && !name.toLowerCase().endsWith(`.${ext}`)) name += `.${ext}`;
    return name;
}

export function parseContentRange(value = "") {
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value).trim());
    if (!match) return null;
    return {
        start: Number(match[1]),
        end: Number(match[2]),
        total: match[3] === "*" ? 0 : Number(match[3])
    };
}

export function parseAttributeList(line = "") {
    const result = {};
    const source = line.includes(":") ? line.slice(line.indexOf(":") + 1) : line;
    const regex = /([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/gi;
    for (const match of source.matchAll(regex)) result[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, "");
    return result;
}

export function parseM3U8(text, playlistURL) {
    const lines = String(text).split(/\r?\n/).map(line => line.trim());
    if (!lines.some(line => line === "#EXTM3U")) throw new Error(t("invalid_m3u8"));
    const variants = [];
    const audioRenditions = [];
    const segments = [];
    let mediaSequence = 0;
    let duration = 0;
    let pendingVariant = null;
    let pendingDuration = 0;
    let pendingByteRange = null;
    let map = null;
    let key = null;
    let endList = false;
    const byteRangeEnd = new Map();

    const normalizeByteRange = (range, url) => {
        if (!range?.length) return null;
        const offset = Number.isFinite(range.offset) ? range.offset : (byteRangeEnd.get(url) || 0);
        byteRangeEnd.set(url, offset + range.length);
        return { length: range.length, offset };
    };

    for (const line of lines) {
        if (!line) continue;
        if (line.startsWith("#EXT-X-STREAM-INF:")) {
            pendingVariant = parseAttributeList(line);
            continue;
        }
        if (line.startsWith("#EXT-X-MEDIA:")) {
            const attributes = parseAttributeList(line);
            if (attributes.TYPE === "AUDIO") {
                audioRenditions.push({
                    type: "audio",
                    groupId: attributes["GROUP-ID"] || "",
                    name: attributes.NAME || attributes.LANGUAGE || t("audio"),
                    language: attributes.LANGUAGE || "",
                    default: attributes.DEFAULT === "YES",
                    autoselect: attributes.AUTOSELECT === "YES",
                    channels: attributes.CHANNELS || "",
                    characteristics: attributes.CHARACTERISTICS || "",
                    url: attributes.URI ? absoluteURL(attributes.URI, playlistURL) : null
                });
            }
            continue;
        }
        if (pendingVariant && !line.startsWith("#")) {
            const resolution = (pendingVariant.RESOLUTION || "0x0").split("x").map(Number);
            variants.push({
                url: absoluteURL(line, playlistURL),
                bandwidth: Number(pendingVariant["AVERAGE-BANDWIDTH"] || pendingVariant.BANDWIDTH || 0),
                width: resolution[0] || 0,
                height: resolution[1] || 0,
                codecs: pendingVariant.CODECS || "",
                frameRate: Number(pendingVariant["FRAME-RATE"] || 0),
                name: pendingVariant.NAME || "",
                audioGroup: pendingVariant.AUDIO || ""
            });
            pendingVariant = null;
            continue;
        }
        if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) mediaSequence = Number(line.split(":")[1] || 0);
        else if (line.startsWith("#EXTINF:")) pendingDuration = Number(line.slice(8).split(",")[0]) || 0;
        else if (line.startsWith("#EXT-X-BYTERANGE:")) {
            const [length, offset] = line.slice(17).split("@").map(Number);
            pendingByteRange = { length, offset: Number.isFinite(offset) ? offset : null };
        } else if (line.startsWith("#EXT-X-MAP:")) {
            const attributes = parseAttributeList(line);
            const url = absoluteURL(attributes.URI, playlistURL);
            const [length, offset] = (attributes.BYTERANGE || "").split("@").map(Number);
            map = { url, byteRange: normalizeByteRange(Number.isFinite(length) ? { length, offset: Number.isFinite(offset) ? offset : null } : null, url), key: key ? { ...key } : null };
        } else if (line.startsWith("#EXT-X-KEY:")) {
            const attributes = parseAttributeList(line);
            key = attributes.METHOD === "NONE" ? null : { method: attributes.METHOD, url: absoluteURL(attributes.URI, playlistURL), iv: attributes.IV || null };
        } else if (line === "#EXT-X-ENDLIST") endList = true;
        else if (!line.startsWith("#")) {
            const sequence = mediaSequence + segments.length;
            const url = absoluteURL(line, playlistURL);
            segments.push({ index: segments.length, sequence, url, duration: pendingDuration, startTime: duration, byteRange: normalizeByteRange(pendingByteRange, url), key: key ? { ...key } : null });
            duration += pendingDuration;
            pendingDuration = 0;
            pendingByteRange = null;
        }
    }
    variants.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
    return { variants, audioRenditions, segments, map, duration, mediaSequence, endList };
}

export function audioRenditionsForVariant(playlist, variant) {
    if (!variant?.audioGroup) return [];
    return (playlist?.audioRenditions || []).filter(rendition => rendition.groupId === variant.audioGroup);
}

export function chooseAudioRendition(playlist, variant, preferredLanguage = "") {
    const renditions = audioRenditionsForVariant(playlist, variant);
    if (!renditions.length) return null;
    if (preferredLanguage) {
        const language = preferredLanguage.toLowerCase();
        const preferred = renditions.find(item => item.language.toLowerCase() === language || item.language.toLowerCase().startsWith(`${language}-`));
        if (preferred) return preferred;
    }
    return renditions.find(item => item.default) || renditions.find(item => item.autoselect) || renditions[0];
}

export function collapseHLSProbeEntries(entries = []) {
    const referencedPlaylists = new Set();
    for (const entry of entries) {
        for (const variant of entry.playlist?.variants || []) if (variant.url) referencedPlaylists.add(variant.url);
        for (const rendition of entry.playlist?.audioRenditions || []) if (rendition.url) referencedPlaylists.add(rendition.url);
    }
    return entries.filter(entry => {
        if (entry.playlist?.variants?.length) return true;
        return !referencedPlaylists.has(entry.candidate?.url);
    });
}

function entryQuality(entry) {
    const candidate = entry?.candidate || {};
    const area = (Number(candidate.width) || 0) * (Number(candidate.height) || 0);
    const sourceRank = { player: 4, source: 3, element: 2, performance: 1, link: 0 }[candidate.source] || 0;
    const verifiedType = candidate.type && candidate.type !== "unknown" ? 1_000_000_000_000 : 0;
    return verifiedType + area + (Number(candidate.duration) || 0) + sourceRank;
}

export function collapseDuplicateMediaEntries(entries = []) {
    const unique = new Map();
    for (const entry of entries) {
        const candidate = entry?.candidate;
        if (!candidate?.url) continue;
        const key = candidate.url;
        const previous = unique.get(key);
        if (!previous) {
            unique.set(key, entry);
            continue;
        }
        const preferred = entryQuality(entry) > entryQuality(previous) ? entry : previous;
        const other = preferred === entry ? previous : entry;
        unique.set(key, {
            ...other,
            ...preferred,
            candidate: {
                ...other.candidate,
                ...preferred.candidate,
                width: Math.max(Number(other.candidate?.width) || 0, Number(preferred.candidate?.width) || 0),
                height: Math.max(Number(other.candidate?.height) || 0, Number(preferred.candidate?.height) || 0),
                duration: Math.max(Number(other.candidate?.duration) || 0, Number(preferred.candidate?.duration) || 0)
            }
        });
    }
    return [...unique.values()];
}

export function filterMediaEntries(entries = [], settings = {}) {
    if (settings.filterEnabled === false) return [...entries];
    const minHeight = Math.max(0, Number(settings.minVideoHeight) || 0);
    const minDuration = Math.max(0, Number(settings.minMediaDuration) || 0);
    const audioTypes = new Set(["mp3", "m4a", "aac"]);
    return entries.filter(entry => {
        const candidate = entry?.candidate || {};
        const playlistHeights = (entry?.playlist?.variants || []).map(variant => Number(variant.height) || 0);
        const height = Math.max(Number(candidate.height) || 0, ...playlistHeights);
        const duration = Math.max(Number(candidate.duration) || 0, Number(entry?.playlist?.duration) || 0);
        if (!audioTypes.has(candidate.type) && candidate.mediaKind !== "audio" && minHeight && height && height < minHeight) return false;
        if (minDuration && duration && duration < minDuration) return false;
        return true;
    });
}

export function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (!bytes) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / (1024 ** unit)).toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

export function formatDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = total % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}` : `${minutes}:${String(rest).padStart(2, "0")}`;
}
import { t } from "./i18n.js";
