import { audioRenditionsForVariant, chooseAudioRendition, collapseDuplicateMediaEntries, collapseHLSProbeEntries, compactMediaURL, filterMediaEntries, formatBytes, formatDuration, safeFilename } from "./core.js";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./settings.js";
import { localizeDocument, t } from "./i18n.js";

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
    try { return decodeURIComponent(new URL(candidate.url).pathname.split("/").pop()) || candidate.pageTitle || t("video"); }
    catch { return candidate.pageTitle || t("video"); }
}

function preferredName(candidate) {
    return settings.fileNaming === "resource-filename" ? displayName(candidate) : candidate.pageTitle || displayName(candidate);
}

async function startDownload(candidate, button, streamOptions = {}) {
    button.disabled = true;
    button.textContent = t("processing");
    try {
        if (candidate.type === "hls") {
            const { qualitySelect, audioSelect, playlist } = streamOptions;
            const selectedURL = qualitySelect?.value || candidate.url;
            const selectedLabel = qualitySelect?.selectedOptions[0]?.textContent || t("highest_quality");
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
            else toast(response?.error || t("create_download_failed"));
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
            else toast(result?.error || t("download_failed"));
        }
    } catch (error) {
        toast(error.message || t("download_failed"));
    } finally {
        button.disabled = false;
        button.textContent = t("download");
    }
}

function renderCandidate(candidate, playlist = null) {
    const card = document.createElement("article");
    card.className = "media-card";
    card.innerHTML = `<div class="media-top"><div class="type-icon"></div><div class="media-copy"><div class="media-title"></div><div class="media-meta"></div><div class="media-url"></div></div></div><div class="quality-row"></div>`;
    card.querySelector(".type-icon").textContent = candidate.type === "unknown" ? t(candidate.mediaKind || "media") : candidate.type;
    card.querySelector(".media-title").textContent = displayName(candidate);
    const urlLabel = card.querySelector(".media-url");
    urlLabel.textContent = compactMediaURL(candidate.url);
    urlLabel.title = candidate.url;
    const meta = [];
    if (candidate.width && candidate.height) meta.push(`${candidate.width}×${candidate.height}`);
    if (candidate.duration) meta.push(formatDuration(candidate.duration));
    const sourceKey = ["player", "element", "source", "link", "performance", "fetch", "xhr", "network"].includes(candidate.source) ? `source_${candidate.source}` : "page_resource";
    meta.push(t(sourceKey));
    card.querySelector(".media-meta").textContent = meta.join(" · ");
    const row = card.querySelector(".quality-row");
    let qualitySelect = null;
    let audioSelect = null;
    if (candidate.type === "hls") {
        const selects = document.createElement("div");
        selects.className = "stream-selects";
        qualitySelect = document.createElement("select");
        qualitySelect.setAttribute("aria-label", t("video_quality"));
        const automatic = document.createElement("option");
        automatic.value = candidate.url;
        automatic.textContent = t("auto_highest_quality");
        qualitySelect.appendChild(automatic);
        selects.appendChild(qualitySelect);
        row.appendChild(selects);
        if (playlist?.variants?.length) {
            qualitySelect.innerHTML = "";
            playlist.variants.forEach((variant, index) => {
                const option = document.createElement("option");
                option.value = variant.url;
                option.textContent = `${variant.height ? `${variant.height}p` : variant.name || t("adaptive")}${variant.bandwidth ? ` · ${(variant.bandwidth / 1e6).toFixed(1)} Mbps` : ""}${index === 0 ? t("highest_suffix") : ""}`;
                qualitySelect.appendChild(option);
            });
            audioSelect = document.createElement("select");
            audioSelect.className = "audio-select";
            audioSelect.setAttribute("aria-label", t("audio_track"));
            const updateAudioOptions = () => {
                const variant = playlist.variants.find(item => item.url === qualitySelect.value);
                const renditions = audioRenditionsForVariant(playlist, variant);
                audioSelect.replaceChildren();
                for (const [index, rendition] of renditions.entries()) {
                    const option = document.createElement("option");
                    option.value = String(index);
                    option.textContent = `${t("audio")} · ${rendition.name}${rendition.language ? ` (${rendition.language})` : ""}${rendition.url ? "" : ` · ${t("embedded")}`}`;
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
        } else if (playlist?.segments?.length) qualitySelect.firstElementChild.textContent = `${t("original_stream")} · ${formatDuration(playlist.duration)}`;
        else if (playlist?.error) qualitySelect.firstElementChild.textContent = t("hls_retry");
    }
    const button = document.createElement("button");
    button.className = "download-button";
    button.textContent = t("download");
    button.addEventListener("click", () => startDownload(candidate, button, { qualitySelect, audioSelect, playlist }));
    row.appendChild(button);
    $("#media-list").appendChild(card);
}

async function refresh() {
    $("#media-list").replaceChildren();
    $("#count").textContent = t("scanning_ellipsis");
    state = await browser.runtime.sendMessage({ type: "GET_MEDIA" });
    $("#page-title").textContent = state.tab?.title || t("page_unavailable");
    $("#record-name").value ||= (state.tab?.title || "recording").slice(0, 150);
    const probed = await Promise.all(state.candidates.map(async candidate => ({
        candidate,
        playlist: candidate.type === "hls" ? await browser.runtime.sendMessage({ type: "PROBE_HLS", url: candidate.url }) : null
    })));
    const discovered = collapseDuplicateMediaEntries(collapseHLSProbeEntries(probed));
    const visible = filterMediaEntries(discovered, settings);
    const hiddenCount = discovered.length - visible.length;
    $("#count").textContent = visible.length
        ? t(hiddenCount ? (visible.length === 1 ? "resource_found_hidden" : "resources_found_hidden") : (visible.length === 1 ? "resource_found" : "resources_found"), [String(visible.length), String(hiddenCount)])
        : hiddenCount ? t(hiddenCount === 1 ? "resource_hidden" : "resources_hidden", String(hiddenCount)) : t("no_resources_found");
    $("#empty").hidden = Boolean(visible.length);
    $("#empty-title").textContent = hiddenCount ? t("resources_filtered") : t("no_media_found");
    $("#empty-help").textContent = hiddenCount ? t("resources_filtered_help") : t("no_media_help");
    visible.forEach(entry => renderCandidate(entry.candidate, entry.playlist));
    updateRecordUI();
}

function updateRecordUI() {
    const record = state.recording || {};
    const active = Boolean(record.recording);
    $(".record-card").classList.toggle("recording", active && !record.paused);
    $("#record-title").textContent = active ? (record.paused ? t("capture_paused") : t("capturing_buffer")) : t("capture_player_buffer");
    $("#record-stats").textContent = active || record.bytes ? t(record.chunks === 1 ? "captured_segment" : "captured_segments", [formatBytes(record.bytes), String(record.chunks || 0)]) : t("not_started");
    $("#record-primary").textContent = active ? (record.paused ? t("resume_capture") : t("pause")) : t("start_capture");
    $("#record-save").hidden = !active;
    $("#record-cancel").hidden = !active;
}

async function recordAction(command, options = {}) {
    const result = await browser.runtime.sendMessage({ type: "RECORD", command, options });
    if (!result?.ok) toast(result?.error || t("operation_failed_retry"));
    await refresh();
}

async function initializeSettings() {
    settings = await loadSettings();
    $("#setting-threads").value = String(settings.downloadThreads);
    $("#setting-auto-save").checked = settings.autoSave;
    $("#setting-file-naming").value = settings.fileNaming;
    $("#setting-show-badge").checked = settings.showBadge;
    $("#setting-filter-enabled").checked = settings.filterEnabled;
    $("#setting-show-audio").checked = settings.showAudio;
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
            fileNaming: $("#setting-file-naming").value,
            showBadge: $("#setting-show-badge").checked,
            filterEnabled: $("#setting-filter-enabled").checked,
            showAudio: $("#setting-show-audio").checked,
            minVideoHeight: Number($("#setting-min-height").value),
            minMediaDuration: Number($("#setting-min-duration").value)
        });
        toast(t("settings_saved"));
    };
    const filterControls = new Set(["#setting-show-audio", "#setting-filter-enabled", "#setting-min-height", "#setting-min-duration"]);
    for (const id of ["#setting-threads", "#setting-auto-save", "#setting-file-naming", "#setting-show-badge", ...filterControls]) {
        $(id).addEventListener("change", () => {
            if (id === "#setting-filter-enabled") syncFilterControls();
            persist()
                .then(() => filterControls.has(id) ? refresh() : null)
                .catch(error => toast(t("settings_save_failed", error.message)));
        });
    }
}

document.addEventListener("DOMContentLoaded", async () => {
    localizeDocument();
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
        const savePartial = confirm(t("save_captured_partial_confirm"));
        recordAction("record-cancel", { filename: $("#record-name").value, savePartial });
    });
    try { await initializeSettings(); }
    catch (error) { toast(t("settings_load_failed", error.message)); }
    refresh();
});
