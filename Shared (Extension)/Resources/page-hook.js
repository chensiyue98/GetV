(() => {
    if (window.__getvHookInstalled) return;
    window.__getvHookInstalled = true;
    const channel = "__getv_bridge_v1__";
    let recording = false;
    let paused = false;
    let chunks = [];
    let mimeType = "video/mp4";
    let capturedBytes = 0;
    const emit = (kind, detail = {}) => window.postMessage({ channel, kind, ...detail }, "*");
    const reportURL = (url, mime = "", source = "network", initiatorType = "") => {
        if (typeof url === "string" && url) emit("resource", { url, mime, source, initiatorType });
    };

    const originalFetch = window.fetch;
    if (originalFetch) window.fetch = async function (...args) {
        const response = await originalFetch.apply(this, args);
        try { reportURL(response.url || String(args[0]), response.headers.get("content-type") || "", "fetch"); } catch {}
        return response;
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__getvURL = url;
        return originalOpen.call(this, method, url, ...rest);
    };
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener("load", () => {
            try { reportURL(this.responseURL || this.__getvURL, this.getResponseHeader("content-type") || "", "xhr"); } catch {}
        }, { once: true });
        return originalSend.apply(this, args);
    };

    if (window.MediaSource) {
        const originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
        MediaSource.prototype.addSourceBuffer = function (type) {
            const sourceBuffer = originalAddSourceBuffer.call(this, type);
            mimeType = type || mimeType;
            const originalAppend = sourceBuffer.appendBuffer;
            sourceBuffer.appendBuffer = function (data) {
                if (recording && !paused && data?.byteLength) {
                    const copy = data instanceof ArrayBuffer ? data.slice(0) : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
                    chunks.push(copy);
                    capturedBytes += copy.byteLength;
                    emit("record-progress", { bytes: capturedBytes, chunks: chunks.length, mime: mimeType });
                }
                return originalAppend.call(this, data);
            };
            return sourceBuffer;
        };
    }

    const downloadCapture = (requestedName, keepPartial = true) => {
        if (!chunks.length) return { ok: false, errorCode: "no_captured_data" };
        const baseMime = mimeType.split(";")[0] || "video/mp4";
        const extension = baseMime.includes("webm") ? "webm" : "mp4";
        const safe = String(requestedName || `recording-${Date.now()}`).replace(/[\\/:*?\"<>|]/g, " ").trim();
        const name = safe.toLowerCase().endsWith(`.${extension}`) ? safe : `${safe}.${extension}`;
        const blob = new Blob(chunks, { type: baseMime });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = name;
        anchor.style.display = "none";
        (document.body || document.documentElement).appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        const bytes = capturedBytes;
        if (!keepPartial) { chunks = []; capturedBytes = 0; }
        return { ok: true, bytes, name, mime: baseMime };
    };

    window.addEventListener("message", event => {
        if (event.source !== window || event.data?.channel !== channel || event.data?.kind !== "command") return;
        const { command, requestId, options = {} } = event.data;
        let result = { ok: true };
        if (command === "record-start") { chunks = []; capturedBytes = 0; paused = false; recording = true; }
        else if (command === "record-pause") paused = true;
        else if (command === "record-resume") paused = false;
        else if (command === "record-stop") { recording = false; result = downloadCapture(options.filename, options.keepPartial !== false); }
        else if (command === "record-cancel") {
            recording = false; paused = false;
            if (options.savePartial) result = downloadCapture(options.filename, false);
            else { chunks = []; capturedBytes = 0; }
        } else if (command === "record-status") result = { ok: true, recording, paused, bytes: capturedBytes, chunks: chunks.length, mime: mimeType };
        emit("command-result", { requestId, result });
    });

    try {
        new PerformanceObserver(list => {
            for (const entry of list.getEntries()) reportURL(entry.name, "", "performance", entry.initiatorType || "");
        }).observe({ type: "resource", buffered: true });
    } catch {}
    emit("ready");
})();
