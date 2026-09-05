import test from "node:test";
import assert from "node:assert/strict";
import { identifyMediaCandidate } from "../Shared (Extension)/Resources/media-probe.js";

function response(body, { type = "", url = "https://media.test/playback", status = 200 } = {}) {
    return new Response(body, { status, headers: type ? { "content-type": type } : {} });
}

test("identifies an extensionless native HLS URL by sniffing its response", async () => {
    const calls = [];
    const fetchImpl = async (_url, options) => {
        calls.push(options.method);
        if (options.method === "HEAD") return response(null, { type: "application/octet-stream" });
        return response("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nvideo.m3u8", { type: "text/plain" });
    };
    const candidate = await identifyMediaCandidate({ url: "https://media.test/playback?id=42", type: "unknown", source: "player" }, fetchImpl);
    assert.equal(candidate.type, "hls");
    assert.deepEqual(calls, ["HEAD", "GET"]);
});

test("uses response MIME without reading a media body", async () => {
    const calls = [];
    const fetchImpl = async (_url, options) => {
        calls.push(options.method);
        return response(null, { type: "video/mp4" });
    };
    const candidate = await identifyMediaCandidate({ url: "https://media.test/playback?id=7", type: "unknown", source: "player" }, fetchImpl);
    assert.equal(candidate.type, "mp4");
    assert.deepEqual(calls, ["HEAD"]);
});

test("rejects an extensionless HTML page instead of creating a false video result", async () => {
    const fetchImpl = async (_url, options) => options.method === "HEAD"
        ? response(null, { type: "text/html" })
        : response("<!doctype html><title>not media</title>", { type: "text/html" });
    const candidate = await identifyMediaCandidate({ url: "https://media.test/page?id=7", type: "unknown", source: "player" }, fetchImpl);
    assert.equal(candidate, null);
});

test("keeps a high-confidence video candidate when its signed CDN URL cannot be re-fetched", async () => {
    const fetchImpl = async () => { throw new TypeError("redirect target refused the connection"); };
    const candidate = await identifyMediaCandidate({
        url: "https://cdn.test/signed-resource?token=short-lived",
        type: "unknown",
        source: "player",
        mediaKind: "video"
    }, fetchImpl);
    assert.equal(candidate.type, "unknown");
    assert.equal(candidate.mediaKind, "video");
    assert.equal(candidate.unverified, true);
});
