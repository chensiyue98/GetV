import { candidateKey, classifyMedia, collapseDuplicateMediaEntries, filterMediaEntries, parseM3U8, safeFilename } from "./core.js";
import { createQueuedTask, storePut } from "./download-db.js";
import { identifyMediaCandidate } from "./media-probe.js";
import { DEFAULT_SETTINGS, loadSettings, SETTINGS_KEY } from "./settings.js";

const candidatesByTab = new Map();
const recordingByTab = new Map();
let badgeSettings = { ...DEFAULT_SETTINGS };
const badgeSettingsReady = loadSettings().then(settings => { badgeSettings = settings; }).catch(() => {});

async function activeTab() {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
}

function tabCandidates(tabId) {
    if (!candidatesByTab.has(tabId)) candidatesByTab.set(tabId, new Map());
    return candidatesByTab.get(tabId);
}

async function updateBadge(tabId) {
    await badgeSettingsReady;
    const entries = [...tabCandidates(tabId).values()].map(candidate => ({ candidate }));
    const count = filterMediaEntries(collapseDuplicateMediaEntries(entries), badgeSettings).length;
    const text = badgeSettings.showBadge && count ? String(Math.min(count, 99)) : "";
    browser.action.setBadgeText({ tabId, text }).catch(() => {});
    browser.action.setBadgeBackgroundColor({ tabId, color: "#635BFF" }).catch(() => {});
}

async function reloadBadgeSettings() {
    badgeSettings = await loadSettings();
    await Promise.all([...candidatesByTab.keys()].map(tabId => updateBadge(tabId)));
}

function bestMediaFrame(tabId) {
    const candidates = [...tabCandidates(tabId).values()];
    candidates.sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)));
    return candidates[0]?.frameId ?? 0;
}

async function probeHLS(url) {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    if (!response.ok) throw new Error(`播放列表请求失败 (${response.status})`);
    const playlist = parseM3U8(await response.text(), response.url || url);
    return { ...playlist, url: response.url || url };
}

browser.runtime.onMessage.addListener((message, sender) => {
    if (message.type === "MEDIA_FOUND" && sender.tab?.id != null) return identifyMediaCandidate(message.candidate).then(identified => {
        if (!identified) return { ok: true, accepted: false };
        const list = tabCandidates(sender.tab.id);
        const candidate = { ...identified, tabId: sender.tab.id, frameId: sender.frameId ?? 0, id: candidateKey(identified) };
        const previous = list.get(candidate.id);
        list.set(candidate.id, previous ? { ...previous, ...candidate } : candidate);
        updateBadge(sender.tab.id);
        return { ok: true, accepted: true };
    }).catch(() => ({ ok: true, accepted: false }));
    if (message.type === "RECORD_PROGRESS" && sender.tab?.id != null) {
        recordingByTab.set(sender.tab.id, { ...(recordingByTab.get(sender.tab.id) || {}), ...message.progress });
        return Promise.resolve({ ok: true });
    }
    if (message.type === "GET_MEDIA") return activeTab().then(async tab => {
        if (!tab) return { tab: null, candidates: [], recording: null };
        const [scanResult, status] = await Promise.all([
            browser.tabs.sendMessage(tab.id, { type: "SCAN_PAGE" }).catch(() => null),
            browser.tabs.sendMessage(tab.id, { type: "RECORD_COMMAND", command: "record-status" }, { frameId: bestMediaFrame(tab.id) }).catch(() => null)
        ]);
        if (status?.ok) recordingByTab.set(tab.id, status);
        if (!scanResult) await new Promise(resolve => setTimeout(resolve, 120));
        return { tab: { id: tab.id, title: tab.title, url: tab.url }, candidates: [...tabCandidates(tab.id).values()].sort((a, b) => (b.height || 0) - (a.height || 0)), recording: recordingByTab.get(tab.id) || null };
    });
    if (message.type === "PROBE_HLS") return probeHLS(message.url).catch(error => ({ error: error.message }));
    if (message.type === "DOWNLOAD_DIRECT") return (async () => {
        const urlType = classifyMedia(message.url);
        const mediaType = urlType !== "unknown" ? urlType : message.mediaType || "unknown";
        const filename = safeFilename(message.filename, mediaType === "unknown" ? "" : mediaType);
        const task = createQueuedTask({
            kind: "direct",
            url: message.url,
            pageURL: message.pageURL || "",
            title: message.title || filename,
            filename,
            mediaType,
            mediaKind: message.mediaKind || "video",
            mime: message.mime || "",
            width: Number(message.width) || 0,
            height: Number(message.height) || 0,
            duration: Number(message.duration) || 0,
            unverified: Boolean(message.unverified)
        });
        await storePut("tasks", task);
        await browser.tabs.create({ url: browser.runtime.getURL(`manager.html#${task.id}`) });
        return { ok: true, id: task.id };
    })().catch(error => ({ ok: false, error: `无法创建下载任务：${error.message}` }));
    if (message.type === "QUEUE_HLS") return (async () => {
        const settings = await loadSettings();
        const task = createQueuedTask({ ...message.job, concurrency: message.job.concurrency || settings.downloadThreads });
        await storePut("tasks", task);
        await browser.tabs.create({ url: browser.runtime.getURL(`manager.html#${task.id}`) });
        return { ok: true, id: task.id };
    })().catch(error => ({ ok: false, error: `无法创建下载任务：${error.message}` }));
    if (message.type === "RECORD") return activeTab().then(async tab => {
        if (!tab) return { ok: false, error: "没有活动标签页" };
        const result = await browser.tabs.sendMessage(tab.id, { type: "RECORD_COMMAND", command: message.command, options: message.options || {} }, { frameId: bestMediaFrame(tab.id) }).catch(error => ({ ok: false, error: error.message }));
        if (message.command === "record-start") recordingByTab.set(tab.id, { recording: true, paused: false, bytes: 0, chunks: 0 });
        else if (message.command === "record-pause") recordingByTab.set(tab.id, { ...(recordingByTab.get(tab.id) || {}), paused: true });
        else if (message.command === "record-resume") recordingByTab.set(tab.id, { ...(recordingByTab.get(tab.id) || {}), paused: false });
        else if (["record-stop", "record-cancel"].includes(message.command)) recordingByTab.set(tab.id, { ...(recordingByTab.get(tab.id) || {}), recording: false });
        return result;
    });
    if (message.type === "OPEN_MANAGER") return browser.tabs.create({ url: browser.runtime.getURL("manager.html") }).then(() => ({ ok: true }));
    return undefined;
});

browser.tabs.onRemoved.addListener(tabId => {
    candidatesByTab.delete(tabId);
    recordingByTab.delete(tabId);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading") {
        candidatesByTab.delete(tabId);
        recordingByTab.delete(tabId);
        updateBadge(tabId);
    }
});

browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[SETTINGS_KEY]) reloadBadgeSettings().catch(() => {});
});
