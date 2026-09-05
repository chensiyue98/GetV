import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

test("vendored mux.js exposes the MP4 transmuxer in a browser context", () => {
    const code = fs.readFileSync(new URL("../Shared (Extension)/Resources/vendor/mux.js/mux-mp4.min.js", import.meta.url), "utf8");
    const context = {
        window: {},
        console,
        Uint8Array,
        Uint16Array,
        Uint32Array,
        Int32Array,
        ArrayBuffer,
        DataView,
        TextDecoder,
        Math,
        Date,
        JSON,
        setTimeout,
        clearTimeout
    };
    context.window = context;
    context.self = context;
    context.globalThis = context;
    vm.runInNewContext(code, context);
    assert.equal(typeof (context.muxjs?.mp4?.Transmuxer || context.muxjs?.Transmuxer), "function");
});
