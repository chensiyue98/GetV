import test from "node:test";
import assert from "node:assert/strict";
import { buildCombinedInitializationSegment, mergeFragmentPair, rewriteFragmentTrackId } from "../Shared (Extension)/Resources/mp4-mux.js";
import { createFile } from "../Shared (Extension)/Resources/vendor/mp4box/mp4box.all.js";

function box(type, payload) {
    const bytes = new Uint8Array(8 + payload.byteLength);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, bytes.byteLength);
    [...type].forEach((value, index) => { bytes[4 + index] = value.charCodeAt(0); });
    bytes.set(payload, 8);
    return bytes;
}

function initializationSegment(options) {
    const file = createFile();
    file.init({ timescale: 1000, duration: 1000 });
    file.addTrack(options);
    return new Uint8Array(file.getBuffer().buffer);
}

function mediaFragment(trackId, payload) {
    const mfhdPayload = new Uint8Array(8);
    new DataView(mfhdPayload.buffer).setUint32(4, 1);
    const tfhdPayload = new Uint8Array(8);
    const tfhdView = new DataView(tfhdPayload.buffer);
    tfhdView.setUint32(0, 0x3a);
    tfhdView.setUint32(4, trackId);
    const trunPayload = new Uint8Array(12);
    const trunView = new DataView(trunPayload.buffer);
    trunView.setUint32(0, 1);
    trunView.setUint32(4, 1);
    trunView.setInt32(8, 0);
    const moof = box("moof", new Uint8Array([
        ...box("mfhd", mfhdPayload),
        ...box("traf", new Uint8Array([...box("tfhd", tfhdPayload), ...box("trun", trunPayload)]))
    ]));
    return new Uint8Array([...moof, ...box("mdat", payload)]);
}

test("rewrites fragmented MP4 track references without touching media bytes", () => {
    const tfhdPayload = new Uint8Array(8);
    new DataView(tfhdPayload.buffer).setUint32(4, 27);
    const moof = box("moof", box("traf", box("tfhd", tfhdPayload)));
    const mdatPayload = new Uint8Array([0, 0, 0, 16, 116, 102, 104, 100, 9, 9, 9, 9, 9, 9, 9, 9]);
    const mdat = box("mdat", mdatPayload);
    const input = new Uint8Array(moof.byteLength + mdat.byteLength);
    input.set(moof);
    input.set(mdat, moof.byteLength);

    const output = rewriteFragmentTrackId(input, 2);
    assert.equal(new DataView(output.buffer).getUint32(28), 2);
    assert.deepEqual(output.slice(moof.byteLength + 8), mdatPayload);
    assert.equal(new DataView(input.buffer).getUint32(28), 27, "input remains immutable");
});

test("relocates absolute tfhd media offsets when fragments move in the output", () => {
    const tfhdPayload = new Uint8Array(16);
    const payloadView = new DataView(tfhdPayload.buffer);
    payloadView.setUint32(0, 1); // base-data-offset-present
    payloadView.setUint32(4, 9);
    payloadView.setBigUint64(8, 500n);
    const fragment = box("moof", box("traf", box("tfhd", tfhdPayload)));
    const output = rewriteFragmentTrackId(fragment, 2, 4096);
    const view = new DataView(output.buffer);
    assert.equal(view.getUint32(28), 2);
    assert.equal(view.getBigUint64(32), 4096n);
});

test("builds one initialization segment containing video and audio tracks", () => {
    const video = initializationSegment({ type: "avc1", hdlr: "vide", timescale: 90000, duration: 1000, media_duration: 90000, width: 160, height: 90 });
    const audio = initializationSegment({ type: "mp4a", hdlr: "soun", timescale: 48000, duration: 1000, media_duration: 48000, channel_count: 2, samplerate: 48000 });
    const combined = buildCombinedInitializationSegment(video, audio);
    const buffer = combined.init.buffer.slice(combined.init.byteOffset, combined.init.byteOffset + combined.init.byteLength);
    buffer.fileStart = 0;
    const parsed = createFile();
    parsed.appendBuffer(buffer, true);
    parsed.flush();
    const tracks = parsed.getInfo().tracks;
    assert.deepEqual(tracks.map(track => track.audio ? "audio" : "video"), ["video", "audio"]);
    assert.equal(tracks.find(track => track.audio).audio.sample_rate, 48000, "Apple players require a valid sample-entry rate");
    assert.equal(combined.videoTrackId, 1);
    assert.equal(combined.audioTrackId, 2);
});

test("pairs video and audio in one Apple-compatible movie fragment", () => {
    const output = mergeFragmentPair(
        mediaFragment(1, new Uint8Array([1, 2, 3])),
        mediaFragment(1, new Uint8Array([4, 5])),
        { videoTrackId: 1, audioTrackId: 2, sequenceNumber: 7 }
    );
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    assert.equal(view.getUint32(0), 112, "one moof contains both traf boxes");
    assert.equal(view.getUint32(20), 7, "fragment sequence is rewritten");
    assert.equal(view.getUint32(40) & 0x020000, 0x020000, "video offsets are relative to the moof");
    assert.equal(view.getUint32(44), 1);
    assert.equal(view.getInt32(64), 120);
    assert.equal(view.getUint32(84) & 0x020000, 0x020000, "audio offsets are relative to the moof");
    assert.equal(view.getUint32(88), 2);
    assert.equal(view.getInt32(108), 123, "audio begins after the video payload");
    assert.deepEqual(output.slice(120), new Uint8Array([1, 2, 3, 4, 5]));
});
