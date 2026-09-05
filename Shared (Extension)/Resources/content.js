(() => {
    const CHANNEL = "__getv_bridge_v1__";
    const pendingCommands = new Map();
    const seen = new Set();

    function injectHook() {
        const script = document.createElement("script");
        script.src = browser.runtime.getURL("page-hook.js");
        script.async = false;
        script.onload = () => script.remove();
        const attach = () => (document.head || document.documentElement)?.appendChild(script);
        if (!attach()) document.addEventListener("readystatechange", attach, { once: true });
    }

    function mediaKind(url = "", mime = "") {
        const value = `${url} ${mime}`.toLowerCase();
        if (/\.m3u8(?:$|[?#\s])|mpegurl/.test(value)) return "hls";
        if (/\.(mp4|m4v)(?:$|[?#\s])|video\/mp4/.test(value)) return "mp4";
        if (/\.webm(?:$|[?#\s])|video\/webm/.test(value)) return "webm";
        if (/\.flv(?:$|[?#\s])|video\/x-flv/.test(value)) return "flv";
        if (/\.mp3(?:$|[?#\s])|audio\/mpeg/.test(value)) return "mp3";
        if (/\.m4a(?:$|[?#\s])|audio\/mp4/.test(value)) return "m4a";
        if (/\.aac(?:$|[?#\s])|audio\/aac/.test(value)) return "aac";
        if (/\.mov(?:$|[?#\s])|video\/quicktime/.test(value)) return "mov";
        if (/\.ts(?:$|[?#\s])|video\/mp2t/.test(value)) return "ts";
        return "unknown";
    }

    function report(candidate) {
        let url;
        try {
            url = new URL(candidate.url, location.href);
            if (!/^https?:$/.test(url.protocol)) return;
            url.hash = "";
        } catch { return; }
        const type = mediaKind(url.href, candidate.mime);
        const mediaKindHint = ["video", "audio"].includes(candidate.mediaKind)
            ? candidate.mediaKind
            : ["video", "audio"].includes(candidate.initiatorType) ? candidate.initiatorType : "";
        if (type === "unknown" && !mediaKindHint && !["player", "element", "source"].includes(candidate.source)) return;
        const key = `${url.href}|${candidate.width || 0}x${candidate.height || 0}`;
        if (seen.has(key)) return;
        seen.add(key);
        return browser.runtime.sendMessage({
            type: "MEDIA_FOUND",
            candidate: {
                ...candidate,
                url: url.href,
                type,
                mediaKind: mediaKindHint || undefined,
                pageURL: location.href,
                pageTitle: document.title || "video",
                frame: window === top ? "top" : "child",
                foundAt: Date.now()
            }
        }).then(result => {
            if (result?.accepted === false) seen.delete(key);
            return result;
        }).catch(() => { seen.delete(key); });
    }

    function scanMedia(media) {
        const reports = [];
        const add = result => { if (result) reports.push(result); };
        const width = media.videoWidth || media.clientWidth || 0;
        const height = media.videoHeight || media.clientHeight || 0;
        const mediaKind = media.tagName?.toLowerCase() === "audio" ? "audio" : "video";
        if (media.currentSrc) add(report({ url: media.currentSrc, mime: media.getAttribute("type") || "", source: "player", mediaKind, width, height, duration: Number.isFinite(media.duration) ? media.duration : 0 }));
        if (media.src) add(report({ url: media.src, mime: media.getAttribute("type") || "", source: "element", mediaKind, width, height, duration: Number.isFinite(media.duration) ? media.duration : 0 }));
        media.querySelectorAll("source[src]").forEach(source => add(report({ url: source.src, mime: source.type, source: "source", mediaKind, width, height })));
        return Promise.allSettled(reports);
    }

    function scanDOM() {
        const reports = [];
        document.querySelectorAll("video, audio").forEach(media => reports.push(scanMedia(media)));
        document.querySelectorAll("a[href]").forEach(anchor => {
            if (/\.(m3u8|mp4|m4v|webm|flv|mp3|m4a|aac|mov|ts)(?:$|[?#])/i.test(anchor.href)) {
                const result = report({ url: anchor.href, source: "link" });
                if (result) reports.push(result);
            }
        });
        try { performance.getEntriesByType("resource").forEach(entry => { const result = report({ url: entry.name, source: "performance", initiatorType: entry.initiatorType }); if (result) reports.push(result); }); } catch {}
        return Promise.allSettled(reports);
    }

    function pageCommand(command, options = {}) {
        return new Promise(resolve => {
            const requestId = crypto.randomUUID();
            const timer = setTimeout(() => {
                pendingCommands.delete(requestId);
                resolve({ ok: false, error: "页面播放器没有响应" });
            }, 2500);
            pendingCommands.set(requestId, result => { clearTimeout(timer); resolve(result); });
            window.postMessage({ channel: CHANNEL, kind: "command", command, requestId, options }, "*");
        });
    }

    window.addEventListener("message", event => {
        if (event.source !== window || event.data?.channel !== CHANNEL) return;
        if (event.data.kind === "resource") report(event.data);
        else if (event.data.kind === "record-progress") browser.runtime.sendMessage({ type: "RECORD_PROGRESS", progress: event.data }).catch(() => {});
        else if (event.data.kind === "command-result") {
            const resolve = pendingCommands.get(event.data.requestId);
            if (resolve) { pendingCommands.delete(event.data.requestId); resolve(event.data.result); }
        }
    });

    browser.runtime.onMessage.addListener(message => {
        if (message.type === "SCAN_PAGE") return scanDOM().then(() => ({ ok: true }));
        if (message.type === "RECORD_COMMAND") return pageCommand(message.command, message.options);
        if (message.type === "DIRECT_SAVE") {
            const anchor = document.createElement("a");
            anchor.href = message.url;
            anchor.download = message.filename || "video";
            anchor.style.display = "none";
            (document.body || document.documentElement).appendChild(anchor);
            anchor.click();
            anchor.remove();
            return Promise.resolve({ ok: true });
        }
        return undefined;
    });

    injectHook();
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => scanDOM(), { once: true });
    else scanDOM();
    const scanLifecycleMedia = event => {
        const tag = event.target?.tagName?.toLowerCase();
        return tag === "video" || tag === "audio" ? scanMedia(event.target) : Promise.resolve([]);
    };
    for (const eventName of ["loadstart", "loadedmetadata", "durationchange"]) document.addEventListener(eventName, scanLifecycleMedia, true);
    const observer = new MutationObserver(() => scanDOM());
    const startObserver = () => {
        if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
        else document.addEventListener("readystatechange", startObserver, { once: true });
    };
    startObserver();
    setInterval(() => scanDOM(), 3000);
})();
