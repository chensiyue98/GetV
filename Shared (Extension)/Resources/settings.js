export const SETTINGS_KEY = "getvSettings";
export const DEFAULT_SETTINGS = Object.freeze({
    downloadThreads: 6,
    autoSave: false,
    clearCacheAfterSave: true,
    fileNaming: "webpage-title",
    showBadge: true,
    filterEnabled: true,
    showAudio: false,
    minVideoHeight: 240,
    minMediaDuration: 10
});

const THREAD_OPTIONS = new Set([2, 4, 6, 8, 12]);
const FILE_NAMING_OPTIONS = new Set(["webpage-title", "resource-filename"]);
const VIDEO_HEIGHT_OPTIONS = new Set([0, 144, 240, 360, 480, 720]);
const MEDIA_DURATION_OPTIONS = new Set([0, 5, 10, 30, 60]);

function normalizeSettings(value = {}) {
    return {
        downloadThreads: THREAD_OPTIONS.has(Number(value.downloadThreads)) ? Number(value.downloadThreads) : DEFAULT_SETTINGS.downloadThreads,
        autoSave: Boolean(value.autoSave),
        clearCacheAfterSave: value.clearCacheAfterSave == null ? DEFAULT_SETTINGS.clearCacheAfterSave : Boolean(value.clearCacheAfterSave),
        fileNaming: FILE_NAMING_OPTIONS.has(value.fileNaming) ? value.fileNaming : DEFAULT_SETTINGS.fileNaming,
        showBadge: value.showBadge == null ? DEFAULT_SETTINGS.showBadge : Boolean(value.showBadge),
        filterEnabled: value.filterEnabled == null ? DEFAULT_SETTINGS.filterEnabled : Boolean(value.filterEnabled),
        showAudio: value.showAudio == null ? DEFAULT_SETTINGS.showAudio : Boolean(value.showAudio),
        minVideoHeight: VIDEO_HEIGHT_OPTIONS.has(Number(value.minVideoHeight)) ? Number(value.minVideoHeight) : DEFAULT_SETTINGS.minVideoHeight,
        minMediaDuration: MEDIA_DURATION_OPTIONS.has(Number(value.minMediaDuration)) ? Number(value.minMediaDuration) : DEFAULT_SETTINGS.minMediaDuration
    };
}

export async function loadSettings(storage = globalThis.browser?.storage?.local) {
    if (!storage) return { ...DEFAULT_SETTINGS };
    const stored = await storage.get(SETTINGS_KEY);
    return normalizeSettings(stored?.[SETTINGS_KEY]);
}

export async function saveSettings(update, storage = globalThis.browser?.storage?.local) {
    const settings = normalizeSettings({ ...(await loadSettings(storage)), ...update });
    if (storage) await storage.set({ [SETTINGS_KEY]: settings });
    return settings;
}
