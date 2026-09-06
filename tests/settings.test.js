import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../Shared (Extension)/Resources/settings.js";

function memoryStorage(initial) {
    let value = initial;
    return {
        async get(key) { return { [key]: value }; },
        async set(update) { value = update.getvSettings; },
        value() { return value; }
    };
}

test("uses safe defaults for download settings", async () => {
    const storage = memoryStorage(undefined);
    assert.deepEqual(await loadSettings(storage), {
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
    assert.deepEqual(DEFAULT_SETTINGS, await loadSettings(storage));
});

test("persists and normalizes download settings", async () => {
    const storage = memoryStorage({ downloadThreads: 99, fileNaming: "invalid", autoSave: 1, clearCacheAfterSave: 0 });
    assert.deepEqual(await loadSettings(storage), {
        downloadThreads: 6,
        autoSave: true,
        clearCacheAfterSave: false,
        fileNaming: "webpage-title",
        showBadge: true,
        filterEnabled: true,
        showAudio: false,
        minVideoHeight: 240,
        minMediaDuration: 10
    });
    const saved = await saveSettings({ downloadThreads: 12, fileNaming: "resource-filename" }, storage);
    assert.equal(saved.downloadThreads, 12);
    assert.equal(saved.fileNaming, "resource-filename");
    assert.deepEqual(storage.value(), saved);
});

test("persists the toolbar badge preference", async () => {
    const storage = memoryStorage(undefined);
    const saved = await saveSettings({ showBadge: false }, storage);
    assert.equal(saved.showBadge, false);
    assert.equal((await loadSettings(storage)).showBadge, false);
});

test("persists and validates resource filter settings", async () => {
    const storage = memoryStorage({ filterEnabled: false, minVideoHeight: 360, minMediaDuration: 30 });
    assert.equal((await loadSettings(storage)).filterEnabled, false);
    assert.equal((await loadSettings(storage)).minVideoHeight, 360);
    assert.equal((await loadSettings(storage)).minMediaDuration, 30);

    const saved = await saveSettings({ filterEnabled: true, minVideoHeight: 123, minMediaDuration: 9 }, storage);
    assert.equal(saved.filterEnabled, true);
    assert.equal(saved.minVideoHeight, 240);
    assert.equal(saved.minMediaDuration, 10);
});

test("defaults existing settings to hidden audio and persists the audio preference", async () => {
    const storage = memoryStorage({ filterEnabled: false });
    assert.equal((await loadSettings(storage)).showAudio, false);
    await saveSettings({ showAudio: true }, storage);
    assert.equal((await loadSettings(storage)).showAudio, true);
    await saveSettings({ showAudio: false }, storage);
    assert.equal((await loadSettings(storage)).showAudio, false);
});
