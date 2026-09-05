import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("creating an HLS task does not use quota-limited storage.local", () => {
    const source = fs.readFileSync(new URL("../Shared (Extension)/Resources/background.js", import.meta.url), "utf8");
    const start = source.indexOf('if (message.type === "QUEUE_HLS")');
    const end = source.indexOf('if (message.type === "RECORD")', start);
    assert.notEqual(start, -1, "QUEUE_HLS handler must exist");
    assert.notEqual(end, -1, "QUEUE_HLS handler boundary must exist");
    assert.doesNotMatch(source.slice(start, end), /storage\.local\.(?:set|get)/, "QUEUE_HLS must persist directly to IndexedDB");
});

test("direct media is queued in the extension manager instead of opened by Safari", () => {
    const source = fs.readFileSync(new URL("../Shared (Extension)/Resources/background.js", import.meta.url), "utf8");
    const start = source.indexOf('if (message.type === "DOWNLOAD_DIRECT")');
    const end = source.indexOf('if (message.type === "QUEUE_HLS")', start);
    assert.notEqual(start, -1, "DOWNLOAD_DIRECT handler must exist");
    assert.notEqual(end, -1, "DOWNLOAD_DIRECT handler boundary must exist");
    const handler = source.slice(start, end);
    assert.match(handler, /createQueuedTask\(\{[\s\S]*kind:\s*"direct"/);
    assert.match(handler, /storePut\("tasks",\s*task\)/);
    assert.match(handler, /manager\.html#\$\{task\.id\}/);
    assert.doesNotMatch(handler, /browser\.downloads\.download/);
});

test("download manager has a dedicated direct-file runner and exporter", () => {
    const source = fs.readFileSync(new URL("../Shared (Extension)/Resources/manager.js", import.meta.url), "utf8");
    assert.match(source, /async function runDirectTask\(task\)/);
    assert.match(source, /async function assembleDirect\(task,\s*partial\)/);
    assert.match(source, /task\.kind\s*===\s*"direct"/);
});
