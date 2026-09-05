import test from "node:test";
import assert from "node:assert/strict";
import { audioRenditionsForVariant, chooseAudioRendition, classifyMedia, collapseDuplicateMediaEntries, collapseHLSProbeEntries, compactMediaURL, filterMediaEntries, parseAttributeList, parseContentRange, parseM3U8, safeFilename } from "../Shared (Extension)/Resources/core.js";

test("classifies supported resources", () => {
    assert.equal(classifyMedia("https://cdn.test/movie.m3u8?token=1"), "hls");
    assert.equal(classifyMedia("https://cdn.test/stream", "video/webm"), "webm");
    assert.equal(classifyMedia("https://cdn.test/audio.mp3"), "mp3");
});

test("parses quoted HLS attributes", () => {
    assert.deepEqual(parseAttributeList('#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"'), {
        BANDWIDTH: "2800000",
        RESOLUTION: "1920x1080",
        CODECS: "avc1.640028,mp4a.40.2"
    });
});

test("sorts master playlist variants by resolution and resolves relative URLs", () => {
    const playlist = parseM3U8(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080
../high/index.m3u8`, "https://video.test/path/master.m3u8");
    assert.equal(playlist.variants[0].height, 1080);
    assert.equal(playlist.variants[0].url, "https://video.test/high/index.m3u8");
    assert.equal(playlist.variants[1].height, 360);
});

test("keeps alternate audio renditions and links them to video variants", () => {
    const playlist = parseM3U8(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-aac",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-aac",NAME="Deutsch",LANGUAGE="de",DEFAULT=NO,AUTOSELECT=YES,URI="audio/de.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio-aac"
video/1080.m3u8`, "https://video.test/master.m3u8");

    assert.equal(playlist.variants[0].audioGroup, "audio-aac");
    assert.equal(playlist.audioRenditions.length, 2);
    assert.equal(playlist.audioRenditions[0].url, "https://video.test/audio/en.m3u8");
    assert.deepEqual(audioRenditionsForVariant(playlist, playlist.variants[0]).map(item => item.language), ["en", "de"]);
    assert.equal(chooseAudioRendition(playlist, playlist.variants[0]).language, "en");
    assert.equal(chooseAudioRendition(playlist, playlist.variants[0], "de").name, "Deutsch");
});

test("does not invent a separate URL for muxed audio renditions", () => {
    const playlist = parseM3U8(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="muxed",NAME="Original",DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=1000000,AUDIO="muxed"
media.m3u8`, "https://video.test/master.m3u8");
    assert.equal(chooseAudioRendition(playlist, playlist.variants[0]).url, null);
});

test("collapses video and audio child playlists into their master candidate", () => {
    const masterCandidate = { url: "https://video.test/master.m3u8", type: "hls" };
    const videoCandidate = { url: "https://video.test/video/1080.m3u8", type: "hls" };
    const audioCandidate = { url: "https://video.test/audio/zh.m3u8", type: "hls" };
    const masterPlaylist = parseM3U8(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="中文",DEFAULT=YES,URI="audio/zh.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,AUDIO="audio"
video/1080.m3u8`, masterCandidate.url);
    const mediaPlaylist = parseM3U8("#EXTM3U\n#EXTINF:4,\nsegment.ts", videoCandidate.url);
    const entries = collapseHLSProbeEntries([
        { candidate: videoCandidate, playlist: mediaPlaylist },
        { candidate: audioCandidate, playlist: mediaPlaylist },
        { candidate: masterCandidate, playlist: masterPlaylist }
    ]);
    assert.deepEqual(entries.map(entry => entry.candidate.url), [masterCandidate.url]);
});

test("collapses duplicate URLs while keeping the best media metadata", () => {
    const entries = collapseDuplicateMediaEntries([
        { candidate: { url: "https://video.test/preview.mp4", type: "unknown", mediaKind: "video", source: "element", width: 148, height: 83, duration: 0 } },
        { candidate: { url: "https://video.test/preview.mp4", type: "mp4", source: "player", width: 256, height: 144, duration: 5 } }
    ]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].candidate.type, "mp4");
    assert.equal(entries[0].candidate.source, "player");
    assert.equal(entries[0].candidate.height, 144);
    assert.equal(entries[0].candidate.duration, 5);
});

test("filters only media with known metadata below configured thresholds", () => {
    const settings = { filterEnabled: true, minVideoHeight: 240, minMediaDuration: 10 };
    const preview = { candidate: { url: "https://video.test/preview.mp4", type: "mp4", width: 256, height: 144, duration: 5 } };
    const unknown = { candidate: { url: "https://video.test/stream", type: "hls" } };
    const audio = { candidate: { url: "https://audio.test/show.mp3", type: "mp3", width: 300, height: 54, duration: 120 } };
    const unverifiedAudio = { candidate: { url: "https://audio.test/signed", type: "unknown", mediaKind: "audio", width: 300, height: 54, duration: 120 } };
    const fullVideo = { candidate: { url: "https://video.test/movie.mp4", type: "mp4", width: 1280, height: 720, duration: 120 } };
    assert.deepEqual(filterMediaEntries([preview, unknown, audio, unverifiedAudio, fullVideo], settings), [unknown, audio, unverifiedAudio, fullVideo]);
    assert.deepEqual(filterMediaEntries([preview], { ...settings, filterEnabled: false }), [preview]);
});

test("uses probed HLS resolution and duration when filtering", () => {
    const entry = {
        candidate: { url: "https://video.test/master.m3u8", type: "hls" },
        playlist: { variants: [{ height: 1080 }], duration: 120 }
    };
    assert.deepEqual(filterMediaEntries([entry], { filterEnabled: true, minVideoHeight: 720, minMediaDuration: 60 }), [entry]);
});

test("parses media sequence, map, encryption and duration", () => {
    const playlist = parseM3U8(`#EXTM3U
#EXT-X-MEDIA-SEQUENCE:42
#EXT-X-MAP:URI="init.mp4"
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x01
#EXTINF:4.5,
one.m4s
#EXTINF:5.5,
two.m4s
#EXT-X-ENDLIST`, "https://video.test/a/list.m3u8");
    assert.equal(playlist.map.url, "https://video.test/a/init.mp4");
    assert.equal(playlist.segments[0].sequence, 42);
    assert.equal(playlist.segments[1].key.url, "https://video.test/a/key.bin");
    assert.equal(playlist.duration, 10);
    assert.equal(playlist.endList, true);
});

test("resolves explicit and implicit byte ranges", () => {
    const playlist = parseM3U8(`#EXTM3U
#EXT-X-BYTERANGE:100@20
media.ts
#EXT-X-BYTERANGE:50
media.ts`, "https://video.test/list.m3u8");
    assert.deepEqual(playlist.segments[0].byteRange, { length: 100, offset: 20 });
    assert.deepEqual(playlist.segments[1].byteRange, { length: 50, offset: 120 });
});

test("sanitizes filenames", () => {
    assert.equal(safeFilename('  my:video/01  ', "mp4"), "my video 01.mp4");
    assert.equal(safeFilename("movie.MP4", "mp4"), "movie.MP4");
});

test("parses resumable direct-download content ranges", () => {
    assert.deepEqual(parseContentRange("bytes 1048576-2097151/8388608"), {
        start: 1048576,
        end: 2097151,
        total: 8388608
    });
    assert.deepEqual(parseContentRange("bytes 0-99/*"), { start: 0, end: 99, total: 0 });
    assert.equal(parseContentRange("not-a-range"), null);
});

test("compacts long signed media URLs for the popup", () => {
    assert.equal(
        compactMediaURL("https://edge1-vienna.example.com/hls2/08/11939/token/master.m3u8?expires=123&signature=very-long"),
        "edge1-vienna.example.com/…/master.m3u8"
    );
    assert.equal(compactMediaURL("https://media.example.com/movie.mp4"), "media.example.com/movie.mp4");
});
