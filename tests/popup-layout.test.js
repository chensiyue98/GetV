import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("long resource details cannot push the popup download button offscreen", () => {
    const css = fs.readFileSync(new URL("../Shared (Extension)/Resources/popup.css", import.meta.url), "utf8");
    assert.match(css, /\.media-list\s*\{[^}]*overflow-x:\s*hidden/s);
    assert.match(css, /\.media-card\s*\{[^}]*max-width:\s*100%/s);
    assert.match(css, /\.download-button[^}]*flex:\s*0\s+0\s+auto/s);
});
