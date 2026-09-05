import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("popup exposes all requested download settings", () => {
    const html = fs.readFileSync(new URL("../Shared (Extension)/Resources/popup.html", import.meta.url), "utf8");
    for (const id of ["setting-threads", "setting-auto-save", "setting-clear-cache", "setting-file-naming", "setting-show-badge", "setting-filter-enabled", "setting-min-height", "setting-min-duration"]) {
        assert.match(html, new RegExp(`id="${id}"`));
    }
    assert.match(html, /Webpage Title/);
    assert.match(html, /Resource Filename/);
});

test("background clears and refreshes the toolbar badge when its preference changes", () => {
    const background = fs.readFileSync(new URL("../Shared (Extension)/Resources/background.js", import.meta.url), "utf8");
    assert.match(background, /badgeSettings\.showBadge\s*&&\s*count/);
    assert.match(background, /browser\.storage\.onChanged\.addListener/);
    assert.match(background, /setBadgeText\(\{\s*tabId,\s*text\s*\}\)/);
});

test("download paths consume auto-save and cache settings", () => {
    const background = fs.readFileSync(new URL("../Shared (Extension)/Resources/background.js", import.meta.url), "utf8");
    const manager = fs.readFileSync(new URL("../Shared (Extension)/Resources/manager.js", import.meta.url), "utf8");
    assert.match(background, /kind:\s*"direct"/);
    assert.equal((manager.match(/saveAs:\s*!settings\.autoSave/g) || []).length, 2);
    assert.match(manager, /settings\.clearCacheAfterSave/);
});
