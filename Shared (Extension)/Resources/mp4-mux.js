import { createFile } from "./vendor/mp4box/mp4box.all.js";
import { t } from "./i18n.js";

const CONTAINER_BOXES = new Set(["moof", "traf", "mfra"]);

function boxType(bytes, offset) {
    return String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
}

function boxHeader(bytes, offset, limit) {
    if (offset + 8 > limit) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let size = view.getUint32(offset);
    let headerSize = 8;
    if (size === 1) {
        if (offset + 16 > limit) return null;
        size = Number(view.getBigUint64(offset + 8));
        headerSize = 16;
    } else if (size === 0) size = limit - offset;
    if (!Number.isSafeInteger(size) || size < headerSize || offset + size > limit) return null;
    return { type: boxType(bytes, offset), size, headerSize };
}

function visitBoxes(bytes, start, limit, visitor, containingMoof = null) {
    let offset = start;
    while (offset < limit) {
        const header = boxHeader(bytes, offset, limit);
        if (!header) break;
        const moofOffset = header.type === "moof" ? offset : containingMoof;
        visitor(header.type, offset, offset + header.headerSize, header.size, moofOffset);
        if (CONTAINER_BOXES.has(header.type)) visitBoxes(bytes, offset + header.headerSize, offset + header.size, visitor, moofOffset);
        offset += header.size;
    }
}

function boxList(bytes, start = 0, limit = bytes.byteLength) {
    const boxes = [];
    let offset = start;
    while (offset < limit) {
        const header = boxHeader(bytes, offset, limit);
        if (!header) break;
        boxes.push({ ...header, offset, contentOffset: offset + header.headerSize, end: offset + header.size });
        offset += header.size;
    }
    return boxes;
}

function joinBytes(parts) {
    const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.byteLength;
    }
    return output;
}

function makeBox(type, payload) {
    const output = new Uint8Array(8 + payload.byteLength);
    const view = new DataView(output.buffer);
    view.setUint32(0, output.byteLength);
    for (let index = 0; index < 4; index += 1) output[4 + index] = type.charCodeAt(index);
    output.set(payload, 8);
    return output;
}

function fragmentContents(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const topLevel = boxList(bytes);
    const moof = topLevel.find(box => box.type === "moof");
    const mdat = topLevel.find(box => box.type === "mdat" && (!moof || box.offset > moof.offset));
    if (!moof || !mdat) throw new Error(t("fmp4_missing_moof_mdat"));
    if (topLevel.filter(box => box.type === "moof").length !== 1) throw new Error(t("multiple_moof_unsupported"));
    const children = boxList(bytes, moof.contentOffset, moof.end);
    const mfhd = children.find(box => box.type === "mfhd");
    const trafs = children.filter(box => box.type === "traf");
    if (!mfhd || trafs.length !== 1) throw new Error(t("single_track_fragment_required"));
    const prefix = topLevel.filter(box => box.offset < moof.offset && ["styp", "emsg"].includes(box.type)).map(box => bytes.slice(box.offset, box.end));
    return {
        prefix,
        mfhd: bytes.slice(mfhd.offset, mfhd.end),
        traf: bytes.slice(trafs[0].offset, trafs[0].end),
        payload: bytes.slice(mdat.contentOffset, mdat.end)
    };
}

function patchTrackFragment(input, trackId, firstDataOffset, absoluteMoofOffset) {
    const bytes = new Uint8Array(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let originalFirstOffset = null;
    visitBoxes(bytes, 0, bytes.byteLength, (type, _offset, contentOffset, size) => {
        if (type === "tfhd" && size >= 16) {
            const flags = view.getUint32(contentOffset);
            if (!(flags & 1)) view.setUint32(contentOffset, flags | 0x020000);
            view.setUint32(contentOffset + 4, trackId);
            if (size >= 24 && (view.getUint32(contentOffset) & 1)) view.setBigUint64(contentOffset + 8, BigInt(absoluteMoofOffset));
        }
        if (type === "trun" && size >= 20 && (view.getUint32(contentOffset) & 1)) {
            const offsetPosition = contentOffset + 8;
            const original = view.getInt32(offsetPosition);
            originalFirstOffset ??= original;
            view.setInt32(offsetPosition, firstDataOffset + (original - originalFirstOffset));
        }
    });
    if (originalFirstOffset == null) throw new Error(t("missing_trun_data_offset"));
    return bytes;
}

export function mergeFragmentPair(videoInput, audioInput, { videoTrackId, audioTrackId, destinationOffset = 0, sequenceNumber = 1 } = {}) {
    const video = fragmentContents(videoInput);
    const audio = fragmentContents(audioInput);
    const prefix = joinBytes(video.prefix);
    const moofSize = 8 + video.mfhd.byteLength + video.traf.byteLength + audio.traf.byteLength;
    const absoluteMoofOffset = destinationOffset + prefix.byteLength;
    const videoDataOffset = moofSize + 8;
    const audioDataOffset = videoDataOffset + video.payload.byteLength;
    const videoTraf = patchTrackFragment(video.traf, videoTrackId, videoDataOffset, absoluteMoofOffset);
    const audioTraf = patchTrackFragment(audio.traf, audioTrackId, audioDataOffset, absoluteMoofOffset);
    const mfhd = new Uint8Array(video.mfhd);
    new DataView(mfhd.buffer, mfhd.byteOffset, mfhd.byteLength).setUint32(12, sequenceNumber);
    const moof = makeBox("moof", joinBytes([mfhd, videoTraf, audioTraf]));
    const mdat = makeBox("mdat", joinBytes([video.payload, audio.payload]));
    return joinBytes([prefix, moof, mdat]);
}

export function rewriteFragmentTrackId(input, trackId, destinationOffset = 0, sequenceNumber = null) {
    const source = input instanceof Uint8Array ? input : new Uint8Array(input);
    const bytes = new Uint8Array(source);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let nextSequence = sequenceNumber;
    visitBoxes(bytes, 0, bytes.byteLength, (type, _offset, contentOffset, size, moofOffset) => {
        if ((type === "tfhd" || type === "sidx" || type === "prft" || type === "tfra") && size >= 16) view.setUint32(contentOffset + 4, trackId);
        if (type === "mfhd" && size >= 16 && Number.isFinite(nextSequence)) view.setUint32(contentOffset + 4, nextSequence++);
        if (type === "tfhd" && size >= 24 && (view.getUint32(contentOffset) & 1) && Number.isFinite(moofOffset)) {
            view.setBigUint64(contentOffset + 8, BigInt(destinationOffset + moofOffset));
        }
    });
    return bytes;
}

function parseInitializationSegment(input) {
    const source = input instanceof Uint8Array ? input : new Uint8Array(input);
    const buffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
    buffer.fileStart = 0;
    const file = createFile();
    let error = "";
    file.onError = (_module, message) => { error = message || t("mp4_init_parse_failed"); };
    file.appendBuffer(buffer, true);
    file.flush();
    if (error) throw new Error(error);
    return { file, info: file.getInfo() };
}

function sourceTrack(parsed, kind) {
    const info = parsed.info.tracks.find(track => kind === "video" ? track.video : track.audio);
    if (!info) throw new Error(t("no_usable_track", kind === "video" ? t("video") : t("audio")));
    const trak = parsed.file.getTrackById(info.id);
    const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0];
    if (!entry) throw new Error(t("mp4_track_missing_config"));
    return { info, trak, entry, file: parsed.file };
}

export function buildCombinedInitializationSegment(videoInput, audioInput) {
    const videoParsed = parseInitializationSegment(videoInput);
    const audioParsed = parseInitializationSegment(audioInput);
    const video = sourceTrack(videoParsed, "video");
    const audio = sourceTrack(audioParsed, "audio");
    const videoTrackId = video.info.id;
    const usedTrackIds = videoParsed.info.tracks.map(track => track.id);
    const audioTrackId = Math.max(0, ...usedTrackIds) + 1;
    const audioTrex = audioParsed.file.moov?.mvex?.trexs?.find(item => item.track_id === audio.info.id);
    const targetMoov = videoParsed.file.moov;
    if (!targetMoov?.mvex || !audioTrex) throw new Error(t("audio_init_missing_fragment_config"));

    audio.trak.tkhd.track_id = audioTrackId;
    audioTrex.track_id = audioTrackId;
    targetMoov.addBox(audio.trak);
    const audioTrackBoxIndex = targetMoov.boxes.lastIndexOf(audio.trak);
    const previousTrackBoxIndex = targetMoov.boxes.reduce((last, box, index) => box.type === "trak" && box !== audio.trak ? index : last, -1);
    if (audioTrackBoxIndex !== previousTrackBoxIndex + 1) {
        targetMoov.boxes.splice(audioTrackBoxIndex, 1);
        targetMoov.boxes.splice(previousTrackBoxIndex + 1, 0, audio.trak);
    }
    targetMoov.mvex.addBox(audioTrex);
    targetMoov.mvhd.next_track_id = Math.max(targetMoov.mvhd.next_track_id, audioTrackId + 1);
    targetMoov.mvhd.duration = 0;
    for (const trak of targetMoov.traks) {
        trak.tkhd.duration = 0;
        trak.mdia.mdhd.duration = 0;
    }
    const stream = videoParsed.file.getBuffer();
    return {
        init: new Uint8Array(stream.buffer),
        videoSourceTrackId: video.info.id,
        audioSourceTrackId: audio.info.id,
        videoTrackId,
        audioTrackId,
        videoCodec: video.info.codec,
        audioCodec: audio.info.codec
    };
}
