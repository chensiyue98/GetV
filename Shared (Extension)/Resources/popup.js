import { audioRenditionsForVariant, chooseAudioRendition, collapseDuplicateMediaEntries, collapseHLSProbeEntries, compactMediaURL, filterMediaEntries, formatBytes, formatDuration, safeFilename } from "./core.js";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./settings.js";

const $ = selector => document.querySelector(selector);
let state = { tab: null, candidates: [], recording: null };
let settings = { ...DEFAULT_SETTINGS };
let toastTimer;

function toast(message) {
    const node = $("#toast");
    node.textContent = message;
    node.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove("show"), 2400);
}

function displayName(candidate) {
    try { return decodeURIComponent(new URL(candidate.url).pathname.split("/").pop()) || candidate.pageTitle || "视频"; }
    catch { return candidate.pageTitle || "视频"; }
}

function preferredName(candidate) {
    return settings.fileNaming === "resource-filename" ? displayName(candidate) : candidate.pageTitle || displayName(candidate);
}

async function startDownload(candidate, button, streamOptions = {}) {
    button.disabled = true;
    button.textContent = "处理中…";
    try {
        if (candidate.type === "hls") {
            const { qualitySelect, audioSelect, playlist } = streamOptions;
            const selectedURL = qualitySelect?.value || candidate.url;
            const selectedLabel = qualitySelect?.selectedOptions[0]?.textContent || "最高画质";
            const variant = playlist?.variants?.find(item => item.url === selectedURL) || null;
            const renditions = audioRenditionsForVariant(playlist, variant);
            const selectedAudio = renditions[Number(audioSelect?.value)] || chooseAudioRendition(playlist, variant);
            const response = await browser.runtime.sendMessage({ type: "QUEUE_HLS", job: {
                url: selectedURL,
                sourceURL: candidate.url,
                audioURL: selectedAudio?.url || null,
                audioName: selectedAudio?.name || "",
                audioLanguage: selectedAudio?.language || "",
                title: candidate.pageTitle || displayName(candidate),
                filename: safeFilename(preferredName(candidate).replace(/\.m3u8(?:$|[?#])/i, ""), "mp4"),
                quality: selectedLabel,
                concurrency: settings.downloadThreads
            }});
            if (response?.ok) window.close();
            else toast(response?.error || "无法创建下载任务");
        } else {
            const result = await browser.runtime.sendMessage({
                type: "DOWNLOAD_DIRECT",
                url: candidate.url,
                filename: preferredName(candidate),
                title: candidate.pageTitle || displayName(candidate),
                pageURL: candidate.pageURL,
                mediaType: candidate.type,
                mediaKind: candidate.mediaKind,
                mime: candidate.mime,
                width: candidate.width,
                height: candidate.height,
                duration: candidate.duration,
                unverified: candidate.unverified
            });
            if (result?.ok) window.close();
            else toast(result?.error || "下载失败");
        }
    } catch (error) {
        toast(error.message || "下载失败");
    } finally {
        button.disabled = false;
        button.textContent = "下载";
    }
}

function renderCandidate(candidate, playlist = null) {
    const card = document.createElement("article");
    card.className = "media-card";
    card.innerHTML = `<div class="media-top"><div class="type-icon"></div><div class="media-copy"><div class="media-title"></div><div class="media-meta"></div><div class="media-url"></div></div></div><div class="quality-row"></div>`;
    card.querySelector(".type-icon").textContent = candidate.type === "unknown" ? candidate.mediaKind || "media" : candidate.type;
    card.querySelector(".media-title").textContent = displayName(candidate);
    const urlLabel = card.querySelector(".media-url");
    urlLabel.textContent = compactMediaURL(candidate.url);
    urlLabel.title = candidate.url;
    const meta = [];
    if (candidate.width && candidate.height) meta.push(`${candidate.width}×${candidate.height}`);
    if (candidate.duration) meta.push(formatDuration(candidate.duration));
    meta.push(candidate.source || "页面资源");
    card.querySelector(".media-meta").textContent = meta.join(" · ");
    const row = card.querySelector(".quality-row");
    let qualitySelect = null;
    let audioSelect = null;
    if (candidate.type === "hls") {
        const selects = document.createElement("div");
        selects.className = "stream-selects";
        qualitySelect = document.createElement("select");
        qualitySelect.setAttribute("aria-label", "视频清晰度");
        const automatic = document.createElement("option");
        automatic.value = candidate.url;
        automatic.textContent = "自动选择最高画质";
        qualitySelect.appendChild(automatic);
        selects.appendChild(qualitySelect);
        row.appendChild(selects);
        if (playlist?.variants?.length) {
            qualitySelect.innerHTML = "";
            playlist.variants.forEach((variant, index) => {
                const option = document.createElement("option");
                option.value = variant.url;
                option.textContent = `${variant.height ? `${variant.height}p` : variant.name || "自适应"}${variant.bandwidth ? ` · ${(variant.bandwidth / 1e6).toFixed(1)} Mbps` : ""}${index === 0 ? "（最高）" : ""}`;
                qualitySelect.appendChild(option);
            });
            audioSelect = document.createElement("select");
            audioSelect.className = "audio-select";
            audioSelect.setAttribute("aria-label", "音轨");
            const updateAudioOptions = () => {
                const variant = playlist.variants.find(item => item.url === qualitySelect.value);
                const renditions = audioRenditionsForVariant(playlist, variant);
                audioSelect.replaceChildren();
                for (const [index, rendition] of renditions.entries()) {
                    const option = document.createElement("option");
                    option.value = String(index);
                    option.textContent = `音频 · ${rendition.name}${rendition.language ? ` (${rendition.language})` : ""}${rendition.url ? "" : " · 内嵌"}`;
                    audioSelect.appendChild(option);
                }
                const preferred = chooseAudioRendition(playlist, variant);
                const selectedIndex = renditions.indexOf(preferred);
                if (selectedIndex >= 0) audioSelect.value = String(selectedIndex);
                audioSelect.hidden = !renditions.length;
            };
            qualitySelect.addEventListener("change", updateAudioOptions);
            selects.appendChild(audioSelect);
            updateAudioOptions();
        } else if (playlist?.segments?.length) qualitySelect.firstElementChild.textContent = `原始流 · ${formatDuration(playlist.duration)}`;
        else if (playlist?.error) qualitySelect.firstElementChild.textContent = "HLS（点击重试）";
    }
    const button = document.createElement("button");
    button.className = "download-button";
    button.textContent = "下载";
    button.addEventListener("click", () => startDownload(candidate, button, { qualitySelect, audioSelect, playlist }));
    row.appendChild(button);
    $("#media-list").appendChild(card);
}

async function refresh() {
    $("#media-list").replaceChildren();
    $("#count").textContent = "正在扫描…";
    state = await browser.runtime.sendMessage({ type: "GET_MEDIA" });
    $("#page-title").textContent = state.tab?.title || "当前页面不可访问";
    $("#record-name").value ||= (state.tab?.title || "recording").slice(0, 150);
    const probed = await Promise.all(state.candidates.map(async candidate => ({
        candidate,
        playlist: candidate.type === "hls" ? await browser.runtime.sendMessage({ type: "PROBE_HLS", url: candidate.url }) : null
    })));
    const discovered = collapseDuplicateMediaEntries(collapseHLSProbeEntries(probed));
    const visible = filterMediaEntries(discovered, settings);
    const hiddenCount = discovered.length - visible.length;
    $("#count").textContent = visible.length
        ? `发现 ${visible.length} 个资源${hiddenCount ? `（已隐藏 ${hiddenCount} 个）` : ""}`
        : hiddenCount ? `已隐藏 ${hiddenCount} 个资源` : "没有发现资源";
    $("#empty").hidden = Boolean(visible.length);
    $("#empty-title").textContent = hiddenCount ? "资源已被过滤" : "暂未发现媒体资源";
    $("#empty-help").textContent = hiddenCount ? "可在“设置”中降低过滤条件或关闭资源过滤。" : "请先播放视频几秒钟，再点“重新扫描”。";
    visible.forEach(entry => renderCandidate(entry.candidate, entry.playlist));
    updateRecordUI();
}

function updateRecordUI() {
    const record = state.recording || {};
    const active = Boolean(record.recording);
    $(".record-card").classList.toggle("recording", active && !record.paused);
    $("#record-title").textContent = active ? (record.paused ? "捕获已暂停" : "正在捕获缓冲") : "捕获播放器缓冲";
    $("#record-stats").textContent = active || record.bytes ? `${formatBytes(record.bytes)} · ${record.chunks || 0} 个分片` : "尚未开始";
    $("#record-primary").textContent = active ? (record.paused ? "继续捕获" : "暂停") : "开始捕获";
    $("#record-save").hidden = !active;
    $("#record-cancel").hidden = !active;
}

async function recordAction(command, options = {}) {
    const result = await browser.runtime.sendMessage({ type: "RECORD", command, options });
    if (!result?.ok) toast(result?.error || "操作失败，请刷新页面后重试");
    await refresh();
}

async function initializeSettings() {
    settings = await loadSettings();
    $("#setting-threads").value = String(settings.downloadThreads);
    $("#setting-auto-save").checked = settings.autoSave;
    $("#setting-clear-cache").checked = settings.clearCacheAfterSave;
    $("#setting-file-naming").value = settings.fileNaming;
    $("#setting-show-badge").checked = settings.showBadge;
    $("#setting-filter-enabled").checked = settings.filterEnabled;
    $("#setting-min-height").value = String(settings.minVideoHeight);
    $("#setting-min-duration").value = String(settings.minMediaDuration);
    const syncFilterControls = () => {
        const disabled = !$("#setting-filter-enabled").checked;
        $("#setting-min-height").disabled = disabled;
        $("#setting-min-duration").disabled = disabled;
    };
    syncFilterControls();
    const persist = async () => {
        settings = await saveSettings({
            downloadThreads: Number($("#setting-threads").value),
            autoSave: $("#setting-auto-save").checked,
            clearCacheAfterSave: $("#setting-clear-cache").checked,
            fileNaming: $("#setting-file-naming").value,
            showBadge: $("#setting-show-badge").checked,
            filterEnabled: $("#setting-filter-enabled").checked,
            minVideoHeight: Number($("#setting-min-height").value),
            minMediaDuration: Number($("#setting-min-duration").value)
        });
        toast("设置已保存");
    };
    const filterControls = new Set(["#setting-filter-enabled", "#setting-min-height", "#setting-min-duration"]);
    for (const id of ["#setting-threads", "#setting-auto-save", "#setting-clear-cache", "#setting-file-naming", "#setting-show-badge", ...filterControls]) {
        $(id).addEventListener("change", () => {
            if (id === "#setting-filter-enabled") syncFilterControls();
            persist()
                .then(() => filterControls.has(id) ? refresh() : null)
                .catch(error => toast(`设置保存失败：${error.message}`));
        });
    }
}

document.addEventListener("DOMContentLoaded", async () => {
    document.querySelectorAll(".tab").forEach(tab => tab.addEventListener("click", () => {
        document.querySelectorAll(".tab, .panel").forEach(node => node.classList.remove("active"));
        tab.classList.add("active");
        $(`#${tab.dataset.panel}`).classList.add("active");
    }));
    $("#refresh").addEventListener("click", refresh);
    $("#open-manager").addEventListener("click", () => browser.runtime.sendMessage({ type: "OPEN_MANAGER" }).then(() => window.close()));
    $("#record-primary").addEventListener("click", () => {
        const record = state.recording || {};
        const command = !record.recording ? "record-start" : record.paused ? "record-resume" : "record-pause";
        recordAction(command);
    });
    $("#record-save").addEventListener("click", () => recordAction("record-stop", { filename: $("#record-name").value, keepPartial: !settings.clearCacheAfterSave }));
    $("#record-cancel").addEventListener("click", () => {
        const savePartial = confirm("要先保存已经捕获的部分吗？");
        recordAction("record-cancel", { filename: $("#record-name").value, savePartial });
    });
    try { await initializeSettings(); }
    catch (error) { toast(`设置读取失败：${error.message}`); }
    refresh();
});
