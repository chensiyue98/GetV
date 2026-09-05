import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const resources = new URL("../Shared (Extension)/Resources/", import.meta.url);
const read = path => fs.readFileSync(new URL(path, resources), "utf8");

test("English and Simplified Chinese locales contain the same messages", () => {
    const english = JSON.parse(read("_locales/en/messages.json"));
    const chinese = JSON.parse(read("_locales/zh_CN/messages.json"));
    assert.deepEqual(Object.keys(chinese).sort(), Object.keys(english).sort());
    for (const [key, value] of Object.entries(english)) assert.ok(value.message, `English message ${key} is empty`);
    for (const [key, value] of Object.entries(chinese)) assert.ok(value.message, `Chinese message ${key} is empty`);
});

test("extension pages only reference defined locale messages", () => {
    const english = JSON.parse(read("_locales/en/messages.json"));
    const sources = ["popup.html", "popup.js", "manager.html", "manager.js", "background.js", "content.js", "core.js", "download-db.js", "mp4-mux.js"]
        .map(read)
        .join("\n");
    const keys = new Set([
        ...sources.matchAll(/\bt\("([a-z0-9_]+)"/g),
        ...sources.matchAll(/data-i18n(?:-[a-z-]+)?="([a-z0-9_]+)"/g)
    ].map(match => match[1]));
    for (const key of keys) assert.ok(english[key], `Missing locale message: ${key}`);
    for (const key of ["extension_name", "extension_description", "no_captured_data", "status_queued", "status_running", "status_paused", "status_assembling", "status_complete", "status_cancelled", "status_error"]) {
        assert.ok(english[key], `Missing indirect locale message: ${key}`);
    }
});

test("manifest uses localized name and description", () => {
    const manifest = JSON.parse(read("manifest.json"));
    assert.equal(manifest.default_locale, "en");
    assert.equal(manifest.name, "__MSG_extension_name__");
    assert.equal(manifest.description, "__MSG_extension_description__");
});
