import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("download manager exposes permanent task deletion and clears persisted data", () => {
    const html = fs.readFileSync(new URL("../Shared (Extension)/Resources/manager.html", import.meta.url), "utf8");
    const source = fs.readFileSync(new URL("../Shared (Extension)/Resources/manager.js", import.meta.url), "utf8");
    assert.match(html, /data-action="delete"/, "manager needs a delete control");
    assert.match(source, /clearTaskParts\("segments", task\.id\)/, "deletion must remove downloaded segments");
    assert.match(source, /clearTaskParts\("outputs", task\.id\)/, "deletion must remove transmuxed outputs");
    assert.match(source, /storeDelete\("tasks", task\.id\)/, "deletion must remove task metadata");
});

test("download manager can clear the whole task list without deleting exported files", () => {
    const html = fs.readFileSync(new URL("../Shared (Extension)/Resources/manager.html", import.meta.url), "utf8");
    const source = fs.readFileSync(new URL("../Shared (Extension)/Resources/manager.js", import.meta.url), "utf8");
    assert.match(html, /id="clear-all"/, "manager needs a one-click clear control");
    assert.match(source, /async function clearAllTasks\(\)/, "manager needs a bulk deletion operation");
    assert.match(source, /已保存到磁盘的 MP4\/TS 不会删除/, "the UI must state that exported files are untouched");
});
