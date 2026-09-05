import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

function contentHarness(resourceEntries = []) {
    const sent = [];
    const documentListeners = new Map();
    const mediaElements = [];
    const document = {
        readyState: "complete",
        title: "Dynamic player",
        head: { appendChild() {} },
        documentElement: { appendChild() {} },
        createElement() { return { remove() {} }; },
        addEventListener(type, listener) { documentListeners.set(type, listener); },
        querySelectorAll(selector) { return selector === "video, audio" ? mediaElements : []; }
    };
    const context = {
        document,
        location: { href: "https://example.test/watch" },
        performance: { getEntriesByType() { return resourceEntries; } },
        browser: { runtime: {
            getURL: value => value,
            sendMessage: message => { sent.push(message); return Promise.resolve({ ok: true, accepted: true }); },
            onMessage: { addListener() {} }
        } },
        MutationObserver: class { observe() {} },
        URL, Date, Promise, crypto, setTimeout, clearTimeout,
        setInterval() {}, addEventListener() {}, postMessage() {}
    };
    context.window = context;
    context.top = context;
    vm.runInNewContext(fs.readFileSync(new URL("../Shared (Extension)/Resources/content.js", import.meta.url), "utf8"), context);
    return { sent, documentListeners, mediaElements };
}

test("reports an extensionless video URL loaded after the document is ready", async () => {
    const harness = contentHarness();
    const media = {
        tagName: "VIDEO",
        currentSrc: "https://media.example.test/playback?id=42&token=x",
        src: "",
        videoWidth: 1920,
        videoHeight: 1080,
        clientWidth: 0,
        clientHeight: 0,
        duration: 12,
        getAttribute() { return ""; },
        querySelectorAll() { return []; }
    };
    harness.mediaElements.push(media);
    assert.ok(harness.documentListeners.has("loadstart"), "dynamic media needs an immediate lifecycle listener");
    await harness.documentListeners.get("loadstart")({ target: media });
    const candidates = harness.sent.filter(message => message.type === "MEDIA_FOUND");
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].candidate.type, "unknown", "the background must verify extensionless candidates");
});

test("reports an extensionless resource initiated by a native video element", () => {
    const url = "https://cdn.example.test/signed-resource?token=short-lived";
    const harness = contentHarness([{ name: url, initiatorType: "video" }]);
    const candidates = harness.sent.filter(message => message.type === "MEDIA_FOUND");
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].candidate.url, url);
    assert.equal(candidates[0].candidate.source, "performance");
    assert.equal(candidates[0].candidate.mediaKind, "video");
});
