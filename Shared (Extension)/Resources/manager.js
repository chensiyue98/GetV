import { saveDownload } from "./save-download.js";
import { chooseAudioRendition, classifyMedia, formatBytes, formatDuration, parseContentRange, parseM3U8, safeFilename } from "./core.js";
import { clearTaskParts, createQueuedTask, storeAll, storeDelete, storePut, taskParts } from "./download-db.js";
import { buildCombinedInitializationSegment, mergeFragmentPair, rewriteFragmentTrackId } from "./mp4-mux.js";
import { loadSettings, saveSettings } from "./settings.js";
import { localizeDocument, t } from "./i18n.js";

const active = new Map();
const deletedTaskIds = new Set();
let tasks = [];

const taskSegments = async (taskId, track) => (await taskParts("segments", taskId)).filter(part => (part.track || "video") === track);
const taskOutputs = async (taskId, track) => (await taskParts("outputs", taskId)).filter(part => (part.track || "video") === track);
const DIRECT_CHUNK_SIZE = 1024 * 1024;

async function saveTask(task) {
    if (deletedTaskIds.has(task.id)) return;
    task.updatedAt = Date.now();
    await storePut("tasks", { ...task });
    render();
}

async function fetchBuffer(url, signal, byteRange) {
    const headers = {};
    if (byteRange?.length && Number.isFinite(byteRange.offset)) headers.Range = `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}`;
    const response = await fetch(url, { credentials: "include", cache: "no-store", headers, signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.arrayBuffer();
}

function sequenceIV(sequence) {
    const iv = new Uint8Array(16);
    let number = BigInt(sequence);
    for (let index = 15; index >= 0; index -= 1) { iv[index] = Number(number & 255n); number >>= 8n; }
    return iv;
}

function parseIV(value, sequence) {
    if (!value) return sequenceIV(sequence);
    const hex = value.replace(/^0x/i, "").padStart(32, "0").slice(-32);
    return new Uint8Array(hex.match(/.{2}/g).map(pair => parseInt(pair, 16)));
}

async function decryptSegment(buffer, keyInfo, sequence, signal, keyCache) {
    if (!keyInfo) return buffer;
    if (keyInfo.method !== "AES-128") throw new Error(t("unsupported_encryption", keyInfo.method));
    if (!keyCache.has(keyInfo.url)) keyCache.set(keyInfo.url, fetchBuffer(keyInfo.url, signal).then(raw => crypto.subtle.importKey("raw", raw, "AES-CBC", false, ["decrypt"])));
    const key = await keyCache.get(keyInfo.url);
    return crypto.subtle.decrypt({ name: "AES-CBC", iv: parseIV(keyInfo.iv, sequence) }, key, buffer);
}

async function fetchPlaylist(url, signal, description) {
    let response = await fetch(url, { credentials: "include", cache: "no-store", signal });
    if (!response.ok) throw new Error(t("playlist_request_failed", [description, String(response.status)]));
    let parsed = parseM3U8(await response.text(), response.url || url);
    return { ...parsed, resolvedURL: url };
}

async function loadPlaylists(task, signal) {
    let master = await fetchPlaylist(task.url, signal, t("video_playlist"));
    if (master.variants.length) {
        const variant = master.variants[0];
        if (!task.audioURL) {
            const rendition = chooseAudioRendition(master, variant);
            task.audioURL = rendition?.url || null;
            task.audioName = rendition?.name || "";
            task.audioLanguage = rendition?.language || "";
        }
        task.url = variant.url;
        master = await fetchPlaylist(variant.url, signal, t("quality_playlist"));
    } else if (!task.audioURL && task.sourceURL && task.sourceURL !== task.url) {
        const sourceMaster = await fetchPlaylist(task.sourceURL, signal, t("master_playlist"));
        const groups = [...new Set(sourceMaster.variants.map(variant => variant.audioGroup).filter(Boolean))];
        const selectedVariant = sourceMaster.variants.find(variant => variant.url === task.url) || (groups.length === 1 ? { audioGroup: groups[0] } : null);
        const rendition = chooseAudioRendition(sourceMaster, selectedVariant);
        task.audioURL = rendition?.url || null;
        task.audioName = rendition?.name || "";
        task.audioLanguage = rendition?.language || "";
    }
    task.audioDiscoveryDone = true;
    if (!master.segments.length) throw new Error(t("video_playlist_empty"));

    let audio = null;
    if (task.audioURL) {
        audio = await fetchPlaylist(task.audioURL, signal, t("audio_playlist"));
        if (audio.variants.length) audio = await fetchPlaylist(audio.variants[0].url, signal, t("audio_media_playlist"));
        if (!audio.segments.length) throw new Error(t("audio_playlist_empty"));
    }
    return { video: master, audio };
}

async function runDirectTask(task) {
    if (active.has(task.id)) return;
    const controller = new AbortController();
    active.set(task.id, controller);
    task.state = "running";
    task.error = "";
    task.cacheCleared = false;
    task.startedAt ||= Date.now();
    await saveTask(task);
    try {
        let existing = await taskSegments(task.id, "direct");
        let offset = existing.reduce((sum, part) => sum + part.size, 0);
        task.bytes = offset;
        task.completedSegments = existing.length;
        if (offset && task.totalBytes && offset >= task.totalBytes) {
            await finishDownload(task);
            return;
        }

        const headers = offset ? { Range: `bytes=${offset}-` } : {};
        const response = await fetch(task.url, {
            credentials: "include",
            cache: "no-store",
            headers,
            referrer: task.pageURL || "",
            referrerPolicy: "strict-origin-when-cross-origin",
            signal: controller.signal
        });
        if (!response.ok) throw new Error(t("file_request_failed", String(response.status)));

        const range = parseContentRange(response.headers.get("content-range") || "");
        if (offset && (response.status !== 206 || (range && range.start !== offset))) {
            await clearTaskParts("segments", task.id);
            existing = [];
            offset = 0;
            task.bytes = 0;
            task.completedSegments = 0;
            if (response.status === 206 && range?.start) throw new Error(t("resume_range_mismatch"));
        }

        task.mime = response.headers.get("content-type") || task.mime || "application/octet-stream";
        const detectedType = classifyMedia(response.url || task.url, task.mime);
        if (detectedType !== "unknown") {
            task.mediaType = detectedType;
            task.filename = safeFilename(task.filename, detectedType);
        }
        const contentLength = Number(response.headers.get("content-length")) || 0;
        task.totalBytes = range?.total || (contentLength ? offset + contentLength : task.totalBytes || 0);
        task.finalURL = response.url || task.url;
        task.resumable = response.status === 206 || /bytes/i.test(response.headers.get("accept-ranges") || "");

        let chunkIndex = existing.length;
        let pending = [];
        let pendingBytes = 0;
        let tickBytes = task.bytes;
        let tickTime = performance.now();
        const flush = async () => {
            if (!pendingBytes || deletedTaskIds.has(task.id)) return;
            const blob = new Blob(pending, { type: task.mime });
            await storePut("segments", { id: `${task.id}:direct:${chunkIndex}`, taskId: task.id, track: "direct", index: chunkIndex, blob, size: blob.size });
            chunkIndex += 1;
            task.completedSegments = chunkIndex;
            pending = [];
            pendingBytes = 0;
        };
        const acceptChunk = async value => {
            if (!value?.byteLength) return;
            pending.push(value);
            pendingBytes += value.byteLength;
            task.bytes += value.byteLength;
            if (pendingBytes >= DIRECT_CHUNK_SIZE) await flush();
            const now = performance.now();
            if (now - tickTime > 500) {
                task.speed = ((task.bytes - tickBytes) * 1000) / (now - tickTime);
                tickBytes = task.bytes;
                tickTime = now;
                await saveTask(task);
            } else render();
        };

        try {
            if (response.body?.getReader) {
                const reader = response.body.getReader();
                while (task.state === "running") {
                    const { done, value } = await reader.read();
                    if (done) break;
                    await acceptChunk(value);
                }
                if (task.state !== "running") await reader.cancel().catch(() => {});
            } else {
                await acceptChunk(new Uint8Array(await response.arrayBuffer()));
            }
        } finally {
            await flush();
        }

        if (task.state === "running") {
            if (task.totalBytes && task.bytes < task.totalBytes) throw new Error(t("connection_ended_early", [formatBytes(task.bytes), formatBytes(task.totalBytes)]));
            await finishDownload(task);
        }
    } catch (error) {
        if (error.name !== "AbortError") {
            task.state = "error";
            task.error = error.message;
            await saveTask(task);
        }
    } finally {
        active.delete(task.id);
        task.speed = 0;
        await saveTask(task);
    }
}

async function runTask(task) {
    if (task.kind === "direct") return runDirectTask(task);
    if (active.has(task.id)) return;
    const controller = new AbortController();
    active.set(task.id, controller);
    task.state = "running";
    task.error = "";
    task.cacheCleared = false;
    task.startedAt ||= Date.now();
    let tickBytes = task.bytes || 0;
    let tickTime = performance.now();
    await saveTask(task);
    try {
        const playlists = await loadPlaylists(task, controller.signal);
        const tracks = [{ track: "video", playlist: playlists.video }];
        if (playlists.audio) tracks.push({ track: "audio", playlist: playlists.audio });
        task.totalSegments = tracks.reduce((sum, item) => sum + item.playlist.segments.length + (item.playlist.map ? 1 : 0), 0);
        task.duration = playlists.video.duration;
        task.container = playlists.video.map ? "fmp4" : "mpegts";
        task.videoContainer = task.container;
        task.audioContainer = playlists.audio ? (playlists.audio.map ? "fmp4" : "mpegts") : null;
        task.liveSnapshot = tracks.some(item => !item.playlist.endList);
        const existing = await taskParts("segments", task.id);
        const completed = new Set(existing.map(item => `${item.track || "video"}:${item.index}`));
        task.completedSegments = completed.size;
        task.bytes = existing.reduce((sum, item) => sum + item.size, 0);
        tickBytes = task.bytes;
        tickTime = performance.now();
        const queue = [];
        for (const { track, playlist } of tracks) {
            if (playlist.map && !completed.has(`${track}:-1`)) queue.push({ track, index: -1, sequence: 0, timeline: -1, url: playlist.map.url, byteRange: playlist.map.byteRange, key: playlist.map.key || null });
            queue.push(...playlist.segments.filter(segment => !completed.has(`${track}:${segment.index}`)).map(segment => ({ ...segment, track, timeline: segment.startTime })));
        }
        const keyCache = new Map();
        let cursor = 0;
        const worker = async () => {
            while (cursor < queue.length && task.state === "running") {
                const segment = queue[cursor++];
                let data = await fetchBuffer(segment.url, controller.signal, segment.byteRange);
                data = await decryptSegment(data, segment.key, segment.sequence, controller.signal, keyCache);
                if (deletedTaskIds.has(task.id)) throw new DOMException(t("task_deleted"), "AbortError");
                await storePut("segments", { id: `${task.id}:${segment.track}:${segment.index}`, taskId: task.id, track: segment.track, index: segment.index, timeline: segment.timeline, duration: segment.duration || 0, blob: new Blob([data]), size: data.byteLength });
                task.completedSegments += 1;
                task.bytes += data.byteLength;
                const now = performance.now();
                if (now - tickTime > 500) {
                    task.speed = ((task.bytes - tickBytes) * 1000) / (now - tickTime);
                    tickBytes = task.bytes; tickTime = now;
                    await saveTask(task);
                } else render();
            }
        };
        const concurrency = Math.max(1, Math.min(12, Number(task.concurrency || document.querySelector("#global-concurrency").value || 6)));
        await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker));
        if (task.state === "running") await finishDownload(task);
    } catch (error) {
        if (error.name !== "AbortError") { task.state = "error"; task.error = error.message; await saveTask(task); }
    } finally {
        active.delete(task.id);
        task.speed = 0;
        await saveTask(task);
    }
}

async function assemble(task, partial) {
    if (task.kind === "direct") return assembleDirect(task, partial);
    if (deletedTaskIds.has(task.id)) return;
    const videoSource = await taskSegments(task.id, "video");
    const audioSource = task.audioURL ? await taskSegments(task.id, "audio") : [];
    if (!videoSource.length) throw new Error(t("no_downloaded_video_segments"));
    if (task.audioURL && !audioSource.length) throw new Error(t("audio_segments_missing"));
    const previousState = task.state;
    task.error = "";
    task.state = "assembling";
    await saveTask(task);
    await clearTaskParts("outputs", task.id);
    let parts = videoSource;
    let outputContainer = task.videoContainer || task.container;

    if (task.audioURL) {
        const videoParts = outputContainer === "mpegts" ? await transmuxTrackToMP4(task, "video", videoSource) : videoSource;
        const audioContainer = task.audioContainer || (audioSource.some(part => part.index < 0) ? "fmp4" : "mpegts");
        const audioParts = audioContainer === "mpegts" ? await transmuxTrackToMP4(task, "audio", audioSource) : audioSource;
        parts = await combineSeparateTracks(videoParts, audioParts);
        outputContainer = "fmp4";
        task.outputWarning = "";
    } else if (outputContainer === "mpegts") {
        try {
            parts = await transmuxTrackToMP4(task, "video", videoSource);
            outputContainer = "fmp4";
            task.outputWarning = "";
        } catch (error) {
            parts = videoSource;
            task.outputWarning = t("transmux_failed_kept_ts", error.message);
        }
    }
    const extension = outputContainer === "fmp4" ? "mp4" : "ts";
    const mime = outputContainer === "fmp4" ? "video/mp4" : "video/mp2t";
    task.outputContainer = outputContainer;
    const blob = new Blob(parts.map(part => part.blob), { type: mime });
    const url = URL.createObjectURL(blob);
    const filename = safeFilename(partial ? task.filename.replace(/\.[^.]+$/, "") + "-partial" : task.filename, extension);
    const settings = await loadSettings();
    let retainURL = false;
    try {
        if (deletedTaskIds.has(task.id)) return;
        const confirmed = await saveDownload({ url, filename, saveAs: !settings.autoSave });
        retainURL = !confirmed;
        task.saveUnconfirmed = !confirmed;
        if (!partial) task.awaitingSave = false;
        if (deletedTaskIds.has(task.id)) return;
        if (partial) task.state = previousState;
        if (!partial) {
            task.state = "complete";
            task.completedAt = Date.now();
            await saveTask(task);
            if (await requestExportCleanup(task, filename, confirmed)) await deleteTask(task, undefined, true);
        }
    } catch (error) {
        task.state = "error";
        task.error = error.message;
        await saveTask(task);
        throw error;
    } finally { if (!retainURL) URL.revokeObjectURL(url); }
    await saveTask(task);
}

async function assembleDirect(task, partial) {
    if (deletedTaskIds.has(task.id)) return;
    const parts = await taskSegments(task.id, "direct");
    if (!parts.length) throw new Error(t("no_downloaded_file_data"));
    const previousState = task.state;
    task.error = "";
    task.state = "assembling";
    await saveTask(task);
    const extension = task.mediaType && task.mediaType !== "unknown" ? task.mediaType : "";
    const baseName = partial ? task.filename.replace(/(\.[^.]+)?$/, "-partial$1") : task.filename;
    const filename = safeFilename(baseName, extension);
    const blob = new Blob(parts.map(part => part.blob), { type: task.mime || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const settings = await loadSettings();
    let retainURL = false;
    try {
        if (deletedTaskIds.has(task.id)) return;
        const confirmed = await saveDownload({ url, filename, saveAs: !settings.autoSave });
        retainURL = !confirmed;
        task.saveUnconfirmed = !confirmed;
        if (!partial) task.awaitingSave = false;
        if (deletedTaskIds.has(task.id)) return;
        if (partial) task.state = previousState;
        if (!partial) {
            task.state = "complete";
            task.completedAt = Date.now();
            await saveTask(task);
            if (await requestExportCleanup(task, filename, confirmed)) await deleteTask(task, undefined, true);
        }
    } catch (error) {
        task.state = "error";
        task.error = error.message;
        await saveTask(task);
        throw error;
    } finally {
        if (!retainURL) URL.revokeObjectURL(url);
    }
    await saveTask(task);
}

// Download completion and user-requested export are separate actions.
async function finishDownload(task) {
    if (deletedTaskIds.has(task.id)) return;
    const settings = await loadSettings();
    if (deletedTaskIds.has(task.id)) return;
    if (settings.autoSave) return assemble(task, false);
    task.state = "complete";
    task.completedAt = Date.now();
    task.awaitingSave = true;
    task.saveUnconfirmed = false;
    task.error = "";
    await saveTask(task);
}

async function transmuxTrackToMP4(task, track, sourceParts) {
    const Transmuxer = globalThis.muxjs?.mp4?.Transmuxer || globalThis.muxjs?.Transmuxer;
    if (!Transmuxer) throw new Error(t("transmuxer_not_loaded"));
    const transmuxer = new Transmuxer({ keepOriginalTimestamps: true, remux: true });
    let currentPart = null;
    let outputIndex = 0;
    let initWritten = false;
    let writes = [];
    transmuxer.on("data", segment => {
        if (deletedTaskIds.has(task.id)) return;
        if (!initWritten && segment.initSegment?.byteLength) {
            initWritten = true;
            writes.push(storePut("outputs", { id: `${task.id}:${track}:init`, taskId: task.id, track, index: -1, timeline: -1, blob: new Blob([segment.initSegment]), size: segment.initSegment.byteLength }));
        }
        if (segment.data?.byteLength) {
            const index = currentPart.index * 100 + outputIndex++;
            writes.push(storePut("outputs", { id: `${task.id}:${track}:${index}`, taskId: task.id, track, index, timeline: currentPart.timeline ?? currentPart.index, duration: currentPart.duration || 0, blob: new Blob([segment.data]), size: segment.data.byteLength }));
        }
    });
    const mediaParts = sourceParts.filter(part => part.index >= 0);
    for (let index = 0; index < mediaParts.length; index += 1) {
        if (deletedTaskIds.has(task.id)) throw new DOMException(t("task_deleted"), "AbortError");
        currentPart = mediaParts[index];
        outputIndex = 0;
        transmuxer.push(new Uint8Array(await mediaParts[index].blob.arrayBuffer()));
        transmuxer.flush();
        await Promise.all(writes);
        writes = [];
        task.transmuxProgress = `${track === "video" ? t("video") : t("audio")} ${index + 1}/${mediaParts.length}`;
        if (index % 5 === 0) render();
    }
    const outputs = await taskOutputs(task.id, track);
    if (!initWritten || outputs.length < 2) throw new Error(t("unsupported_mpegts"));
    return outputs;
}

async function combineSeparateTracks(videoParts, audioParts) {
    const videoInit = videoParts.find(part => part.index < 0);
    const audioInit = audioParts.find(part => part.index < 0);
    if (!videoInit || !audioInit) throw new Error(t("missing_fmp4_init_segments"));
    const combined = buildCombinedInitializationSegment(
        new Uint8Array(await videoInit.blob.arrayBuffer()),
        new Uint8Array(await audioInit.blob.arrayBuffer())
    );
    const videoMedia = videoParts.filter(part => part.index >= 0).sort((a, b) => (a.timeline ?? a.index) - (b.timeline ?? b.index));
    const audioMedia = audioParts.filter(part => part.index >= 0).sort((a, b) => (a.timeline ?? a.index) - (b.timeline ?? b.index));
    if (!videoMedia.length || !audioMedia.length) throw new Error(t("insufficient_separate_segments"));

    const output = [new Blob([combined.init])];
    let destinationOffset = combined.init.byteLength;
    let sequenceNumber = 1;
    const pairCount = Math.max(videoMedia.length, audioMedia.length);
    for (let index = 0; index < pairCount; index += 1) {
        const videoPart = videoMedia[index];
        const audioPart = audioMedia[index];
        let rewritten;
        if (videoPart && audioPart) {
            rewritten = mergeFragmentPair(await videoPart.blob.arrayBuffer(), await audioPart.blob.arrayBuffer(), {
                videoTrackId: combined.videoTrackId,
                audioTrackId: combined.audioTrackId,
                destinationOffset,
                sequenceNumber: sequenceNumber++
            });
        } else {
            const part = videoPart || audioPart;
            const trackId = videoPart ? combined.videoTrackId : combined.audioTrackId;
            rewritten = rewriteFragmentTrackId(await part.blob.arrayBuffer(), trackId, destinationOffset, sequenceNumber++);
        }
        const blob = new Blob([rewritten]);
        output.push(blob);
        destinationOffset += blob.size;
    }
    return output.map((blob, index) => ({ blob, index }));
}

function pauseTask(task) {
    task.state = "paused";
    active.get(task.id)?.abort();
    saveTask(task);
}

async function deleteTask(task, message = t("delete_task_confirm", task.filename), alreadyConfirmed = false) {
    if (!alreadyConfirmed && !confirm(message)) return;
    deletedTaskIds.add(task.id);
    active.get(task.id)?.abort();
    try {
        await clearTaskParts("segments", task.id);
        await clearTaskParts("outputs", task.id);
        await storeDelete("tasks", task.id);
        tasks = tasks.filter(item => item.id !== task.id);
        render();
    } catch (error) {
        deletedTaskIds.delete(task.id);
        alert(t("delete_task_failed", error.message));
    }
}

async function clearAllTasks() {
    if (!tasks.length) return;
    const snapshot = [...tasks];
    if (!confirm(t("clear_all_confirm", String(snapshot.length)))) return;
    for (const task of snapshot) {
        deletedTaskIds.add(task.id);
        active.get(task.id)?.abort();
    }
    const results = await Promise.allSettled(snapshot.map(async task => {
        await clearTaskParts("segments", task.id);
        await clearTaskParts("outputs", task.id);
        await storeDelete("tasks", task.id);
        return task.id;
    }));
    const removedIds = new Set(results.flatMap(result => result.status === "fulfilled" ? [result.value] : []));
    tasks = tasks.filter(task => !removedIds.has(task.id));
    for (const task of tasks) deletedTaskIds.delete(task.id);
    render();
    const failed = results.filter(result => result.status === "rejected");
    if (failed.length) alert(t("clear_tasks_failed", [String(failed.length), failed[0].reason?.message || String(failed[0].reason)]));
}

// A page dialog remains visible even when export finishes outside a user gesture.
function requestExportCleanup(task, filename, confirmed) {
    if (deletedTaskIds.has(task.id)) return Promise.resolve(false);
    const dialog = document.createElement("dialog");
    dialog.className = "export-cleanup";
    const title = document.createElement("h2");
    title.textContent = t(confirmed ? "export_cleanup_title" : "export_requested_title");
    const message = document.createElement("p");
    message.textContent = t(confirmed ? "export_complete_cleanup" : "export_unconfirmed_cleanup", filename);
    const actions = document.createElement("div");
    const keep = document.createElement("button");
    keep.textContent = t("keep_task_cache");
    const remove = document.createElement("button");
    remove.className = "primary";
    remove.textContent = t(confirmed ? "delete_task_cache" : "saved_delete_task_cache");
    actions.append(keep, remove);
    dialog.append(title, message, actions);
    document.body.append(dialog);
    return new Promise(resolve => {
        let accepted = false;
        dialog.addEventListener("close", () => {
            dialog.remove();
            resolve(accepted && !deletedTaskIds.has(task.id));
        }, { once: true });
        keep.addEventListener("click", () => dialog.close());
        remove.addEventListener("click", () => { accepted = true; dialog.close(); });
        dialog.showModal();
        keep.focus();
    });
}

function statusText(task) {
    if (task.state === "complete" && task.awaitingSave) return t("status_cached");
    if (task.state === "complete" && task.saveUnconfirmed) return t("status_save_requested");
    return t(`status_${task.state}`) === `status_${task.state}` ? task.state : t(`status_${task.state}`);
}

function render() {
    const list = document.querySelector("#task-list");
    const rows = new Map(Array.from(list.children, node => [node.dataset.taskId, node]));
    const visibleIds = new Set(tasks.map(task => task.id));
    for (const [id, node] of rows) if (!visibleIds.has(id)) node.remove();
    let rowIndex = 0;
    document.querySelector("#empty").hidden = Boolean(tasks.length);
    for (const task of [...tasks].sort((a, b) => b.createdAt - a.createdAt)) {
        const node = rows.get(task.id) || document.querySelector("#task-template").content.firstElementChild.cloneNode(true);
        node.dataset.taskId = task.id;
        node.dataset.state = task.state;
        const isDirect = task.kind === "direct";
        node.querySelector(".task-icon").textContent = isDirect ? (task.mediaType && task.mediaType !== "unknown" ? task.mediaType : task.mediaKind || "FILE") : "HLS";
        node.querySelector("h2").textContent = task.filename;
        const directDetails = [task.width && task.height ? `${task.width}×${task.height}` : "", task.duration ? formatDuration(task.duration) : "", task.resumable ? t("resumable") : ""].filter(Boolean).join(" · ");
        node.querySelector(".quality").textContent = isDirect
            ? `${directDetails || t("direct_media")}${task.outputWarning ? ` · ${task.outputWarning}` : ""}`
            : `${task.quality || t("auto_highest_quality")}${task.audioName ? ` · ${t("audio")} ${task.audioName}${task.audioLanguage ? ` (${task.audioLanguage})` : ""}` : ""}${task.duration ? ` · ${formatDuration(task.duration)}` : ""}${task.liveSnapshot ? ` · ${t("live_snapshot")}` : ""}${task.outputWarning ? ` · ${task.outputWarning}` : ""}`;
        node.querySelector(".status").textContent = statusText(task);
        const percent = isDirect
            ? task.totalBytes ? Math.min(100, Math.round((task.bytes || 0) / task.totalBytes * 100)) : 0
            : task.totalSegments ? Math.round((task.completedSegments || 0) / task.totalSegments * 100) : 0;
        node.querySelector(".progress span").style.width = `${percent}%`;
        node.querySelector(".numbers").textContent = isDirect
            ? task.cacheCleared ? t("cache_cleared") : `${formatBytes(task.bytes)} / ${task.totalBytes ? formatBytes(task.totalBytes) : t("unknown_size")}`
            : `${task.completedSegments || 0} / ${task.totalSegments || "?"} ${t(task.totalSegments === 1 ? "segment" : "segments")} · ${task.cacheCleared ? t("cache_cleared") : formatBytes(task.bytes)}${task.transmuxProgress && task.state === "assembling" ? ` · ${t("transmuxing")} ${task.transmuxProgress}` : ""}`;
        node.querySelector(".speed").textContent = task.speed ? `${formatBytes(task.speed)}/s` : `${percent}%`;
        node.querySelector(".error").textContent = task.error || "";
        const toggle = node.querySelector('[data-action="toggle"]');
        const needsAudioCheck = !task.awaitingSave && !isDirect && task.state === "complete" && task.sourceURL && !task.audioDiscoveryDone;
        toggle.textContent = task.state === "running" ? t("pause") : needsAudioCheck ? t("detect_audio_track") : task.state === "complete" && task.cacheCleared ? t("download_again") : task.state === "complete" ? t(task.awaitingSave ? "save_to_device" : "export_again") : t("resume");
        toggle.disabled = task.state === "assembling";
        node.querySelector('[data-action="partial"]').disabled = task.state === "assembling";
        toggle.onclick = () => task.state === "running" ? pauseTask(task) : needsAudioCheck || (task.state === "complete" && task.cacheCleared) ? runTask(task) : task.state === "complete" ? assemble(task, false).catch(error => alert(error.message)) : runTask(task);
        node.querySelector('[data-action="partial"]').onclick = () => assemble(task, true).catch(error => alert(error.message));
        node.querySelector('[data-action="rename"]').onclick = async () => {
            const value = prompt(t("new_filename"), task.filename);
            const extension = isDirect
                ? (task.mediaType !== "unknown" ? task.mediaType : "")
                : ((task.outputContainer || task.container) === "mpegts" && !task.audioURL ? "ts" : "mp4");
            if (value) { task.filename = safeFilename(value, extension); await saveTask(task); }
        };
        node.querySelector('[data-action="delete"]').onclick = () => deleteTask(task);
        if (list.children[rowIndex] !== node) list.insertBefore(node, list.children[rowIndex] || null);
        rowIndex += 1;
    }
    document.querySelector("#running-count").textContent = tasks.filter(task => ["running", "assembling"].includes(task.state)).length;
    document.querySelector("#complete-count").textContent = tasks.filter(task => task.state === "complete").length;
    document.querySelector("#cached-size").textContent = formatBytes(tasks.reduce((sum, task) => sum + (task.cacheCleared ? 0 : task.bytes || 0), 0));
}

async function migrateLegacyPendingJobs() {
    try {
        const stored = await browser.storage.local.get("pendingHLSJobs");
        const pending = stored.pendingHLSJobs || [];
        const ids = new Set(tasks.map(task => task.id));
        for (const job of pending) if (!ids.has(job.id)) {
            const task = createQueuedTask(job, job.id, job.createdAt);
            tasks.push(task);
            await storePut("tasks", task);
        }
        await browser.storage.local.remove("pendingHLSJobs");
    } catch (error) {
        console.warn("GetV could not migrate the legacy task queue:", error);
    }
}

async function start() {
    localizeDocument();
    navigator.storage?.persist?.().catch(() => false);
    const settings = await loadSettings();
    document.querySelector("#global-concurrency").value = String(settings.downloadThreads);
    tasks = await storeAll("tasks");
    for (const task of tasks) if (["running", "assembling"].includes(task.state)) task.state = "paused";
    await migrateLegacyPendingJobs();
    render();
    const requested = location.hash.slice(1);
    const queued = requested ? tasks.find(task => task.id === requested) : tasks.find(task => task.state === "queued");
    if (queued) runTask(queued);
    document.querySelector("#resume-all").addEventListener("click", () => tasks.filter(task => ["paused", "queued", "error"].includes(task.state)).forEach(runTask));
    document.querySelector("#clear-all").addEventListener("click", () => clearAllTasks().catch(error => alert(t("clear_failed", error.message))));
    document.querySelector("#global-concurrency").addEventListener("change", async event => {
        await saveSettings({ downloadThreads: Number(event.target.value) });
        tasks.forEach(task => { if (task.state !== "running") task.concurrency = Number(event.target.value); });
    });
}

start().catch(error => alert(t("manager_init_failed", error.message)));
