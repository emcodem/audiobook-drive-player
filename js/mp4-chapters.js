// Parses chapter markers embedded directly in an MP4/M4A/M4B container,
// instead of relying solely on the external ".chapters.json" sidecar (see
// chapters.js) — most audiobook files that HAVE chapters at all store them
// in one of two well-known ways, both handled here:
//
//   1. A Nero-style "chpl" atom (moov/udta/chpl) — a flat list of
//      (start-time, title) pairs. Simple, self-contained.
//   2. The QuickTime chapter-text-track method — the main audio track's
//      "tref" box references a second, hidden text (tx3g) track via a
//      "chap" entry; each sample in that text track IS a chapter title,
//      timed by the track's own sample table (stts/stsz/stsc/stco).
//      This is what most modern tools (ffmpeg included) actually produce.
//
// Only small pieces of the file are ever read — box headers, then just the
// specific byte ranges chapter titles live in — via a "byte source"
// abstraction so the exact same parsing logic works both against an
// already-local Blob (a downloaded book — zero network) and against a
// remote file via HTTP Range requests (a book that's only streaming).
import { logDebug } from './debug-log.js';

// ---- Byte sources ---------------------------------------------------

export function blobByteSource(blob) {
  return {
    length: blob.size,
    async readRange(start, end) {
      return blob.slice(start, end).arrayBuffer();
    },
  };
}

// Probes Content-Range on a tiny 1-byte request to learn the file's total
// size (works whether the URL is served from our local blob cache or
// proxied live from Drive — see service-worker.js — since both paths
// already report real Content-Range/Content-Length for Range requests).
export async function createHttpRangeByteSource(url) {
  const probe = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  const contentRange = probe.headers.get('Content-Range');
  const total = contentRange
    ? Number(contentRange.split('/')[1])
    : Number(probe.headers.get('Content-Length'));
  if (!total) throw new Error('could not determine file size for Range parsing');

  return {
    length: total,
    async readRange(start, end) {
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` } });
      if (!res.ok) throw new Error(`range fetch failed: ${res.status}`);
      return res.arrayBuffer();
    },
  };
}

// ---- Low-level ISO-BMFF (MP4) box reading ----------------------------

async function readBoxHeader(byteSource, offset) {
  const head = new DataView(await byteSource.readRange(offset, offset + 8));
  let size = head.getUint32(0);
  const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
  let headerSize = 8;
  if (size === 1) {
    const ext = new DataView(await byteSource.readRange(offset + 8, offset + 16));
    size = ext.getUint32(0) * 2 ** 32 + ext.getUint32(4);
    headerSize = 16;
  } else if (size === 0) {
    size = byteSource.length - offset;
  }
  return { type, offset, headerSize, size };
}

async function walkBoxes(byteSource, start, end) {
  const boxes = [];
  let pos = start;
  while (pos < end - 8) {
    // eslint-disable-next-line no-await-in-loop
    const box = await readBoxHeader(byteSource, pos);
    if (box.size <= 0 || pos + box.size > end) break; // malformed guard
    boxes.push(box);
    pos += box.size;
  }
  return boxes;
}

async function readBytes(byteSource, start, end) {
  return new DataView(await byteSource.readRange(start, end));
}

function childRange(box) {
  return { start: box.offset + box.headerSize, end: box.offset + box.size };
}

// ---- "chpl" atom (Nero-style chapter list) ---------------------------

async function parseChplBox(byteSource, chplBox) {
  const { start, end } = childRange(chplBox);
  const data = await readBytes(byteSource, start, end);
  // version(1) + flags(3) + reserved(4) + chapter_count(1), then per entry:
  // start_time as 100ns units (8 bytes, big-endian) + title_length(1) + title.
  let pos = 8;
  const count = data.getUint8(pos);
  pos += 1;
  const chapters = [];
  for (let i = 0; i < count; i++) {
    if (pos + 9 > data.byteLength) break;
    const ticks100ns = data.getUint32(pos) * 2 ** 32 + data.getUint32(pos + 4);
    pos += 8;
    const titleLen = data.getUint8(pos);
    pos += 1;
    if (pos + titleLen > data.byteLength) break;
    const titleBytes = new Uint8Array(data.buffer, data.byteOffset + pos, titleLen);
    pos += titleLen;
    chapters.push({ title: new TextDecoder().decode(titleBytes), start: ticks100ns / 10_000_000 });
  }
  return chapters;
}

// ---- QuickTime chapter text-track method -----------------------------

async function getTrackId(byteSource, trak) {
  const { start, end } = childRange(trak);
  const children = await walkBoxes(byteSource, start, end);
  const tkhd = children.find((b) => b.type === 'tkhd');
  if (!tkhd) return null;
  const r = childRange(tkhd);
  const dv = await readBytes(byteSource, r.start, r.end);
  const version = dv.getUint8(0);
  return dv.getUint32(version === 1 ? 20 : 12);
}

async function findChildByPath(byteSource, box, path) {
  let current = box;
  for (const type of path) {
    const r = childRange(current);
    // eslint-disable-next-line no-await-in-loop
    const children = await walkBoxes(byteSource, r.start, r.end);
    const next = children.find((b) => b.type === type);
    if (!next) return null;
    current = next;
  }
  return current;
}

// Reconstructs each sample's (startTimeInTicks, byteOffset, byteSize) from
// the track's sample table — the standard stts/stsc/stco(-or-co64)/stsz
// cross-referencing algorithm every MP4 demuxer implements.
async function parseSampleTable(byteSource, stblBox) {
  const r = childRange(stblBox);
  const children = await walkBoxes(byteSource, r.start, r.end);
  const stts = children.find((b) => b.type === 'stts');
  const stsz = children.find((b) => b.type === 'stsz');
  const stsc = children.find((b) => b.type === 'stsc');
  const stco = children.find((b) => b.type === 'stco');
  const co64 = children.find((b) => b.type === 'co64');
  if (!stts || !stsz || !stsc || (!stco && !co64)) return null;

  // stts: sample_count/sample_delta pairs → cumulative start tick per sample.
  const sttsR = childRange(stts);
  const sttsData = await readBytes(byteSource, sttsR.start, sttsR.end);
  const sttsEntryCount = sttsData.getUint32(4);
  const sampleStarts = [];
  let tick = 0;
  for (let i = 0; i < sttsEntryCount; i++) {
    const base = 8 + i * 8;
    const count = sttsData.getUint32(base);
    const delta = sttsData.getUint32(base + 4);
    for (let j = 0; j < count; j++) {
      sampleStarts.push(tick);
      tick += delta;
    }
  }
  const totalSamples = sampleStarts.length;

  // stsz: per-sample byte sizes (or one uniform size for all samples).
  const stszR = childRange(stsz);
  const stszData = await readBytes(byteSource, stszR.start, stszR.end);
  const uniformSize = stszData.getUint32(4);
  const stszCount = stszData.getUint32(8);
  const sampleSizes = new Array(stszCount);
  if (uniformSize !== 0) {
    sampleSizes.fill(uniformSize);
  } else {
    for (let i = 0; i < stszCount; i++) sampleSizes[i] = stszData.getUint32(12 + i * 4);
  }

  // stsc: which chunk each run of samples belongs to.
  const stscR = childRange(stsc);
  const stscData = await readBytes(byteSource, stscR.start, stscR.end);
  const stscCount = stscData.getUint32(4);
  const stscEntries = [];
  for (let i = 0; i < stscCount; i++) {
    const base = 8 + i * 12;
    stscEntries.push({
      firstChunk: stscData.getUint32(base),
      samplesPerChunk: stscData.getUint32(base + 4),
    });
  }

  // stco/co64: absolute file offset of each chunk's first sample.
  let chunkOffsets;
  if (stco) {
    const r2 = childRange(stco);
    const d = await readBytes(byteSource, r2.start, r2.end);
    const count = d.getUint32(4);
    chunkOffsets = new Array(count);
    for (let i = 0; i < count; i++) chunkOffsets[i] = d.getUint32(8 + i * 4);
  } else {
    const r2 = childRange(co64);
    const d = await readBytes(byteSource, r2.start, r2.end);
    const count = d.getUint32(4);
    chunkOffsets = new Array(count);
    for (let i = 0; i < count; i++) chunkOffsets[i] = d.getUint32(8 + i * 8) * 2 ** 32 + d.getUint32(12 + i * 8);
  }

  // Expand stsc into per-chunk sample counts, walk chunks in order, and lay
  // out each sample's absolute file offset back-to-back within its chunk.
  const sampleOffsets = new Array(totalSamples);
  let sample = 0;
  for (let chunkIdx = 0; chunkIdx < chunkOffsets.length && sample < totalSamples; chunkIdx++) {
    let samplesPerChunk = stscEntries[stscEntries.length - 1].samplesPerChunk;
    for (let e = 0; e < stscEntries.length; e++) {
      const nextFirstChunk = e + 1 < stscEntries.length ? stscEntries[e + 1].firstChunk : Infinity;
      if (chunkIdx + 1 >= stscEntries[e].firstChunk && chunkIdx + 1 < nextFirstChunk) {
        samplesPerChunk = stscEntries[e].samplesPerChunk;
        break;
      }
    }
    let offsetInChunk = 0;
    for (let s = 0; s < samplesPerChunk && sample < totalSamples; s++, sample++) {
      sampleOffsets[sample] = chunkOffsets[chunkIdx] + offsetInChunk;
      offsetInChunk += sampleSizes[sample];
    }
  }

  return { sampleStarts, sampleSizes, sampleOffsets, totalSamples };
}

async function getTimescale(byteSource, trak) {
  const mdhd = await findChildByPath(byteSource, trak, ['mdia', 'mdhd']);
  if (!mdhd) return null;
  const r = childRange(mdhd);
  const dv = await readBytes(byteSource, r.start, r.end);
  const version = dv.getUint8(0);
  return dv.getUint32(version === 1 ? 20 : 12);
}

// A QuickTime text sample is a 2-byte big-endian length prefix followed by
// that many bytes of title text (any trailing style/encoding atoms in the
// sample are ignored — we only want the title).
async function readTextSample(byteSource, offset, size) {
  const data = await readBytes(byteSource, offset, offset + size);
  if (data.byteLength < 2) return '';
  const textLen = data.getUint16(0);
  const bytes = new Uint8Array(data.buffer, data.byteOffset + 2, Math.min(textLen, data.byteLength - 2));
  return new TextDecoder().decode(bytes);
}

async function parseChapterTextTrack(byteSource, chapterTrak) {
  const timescale = await getTimescale(byteSource, chapterTrak);
  const stbl = await findChildByPath(byteSource, chapterTrak, ['mdia', 'minf', 'stbl']);
  if (!timescale || !stbl) return null;

  const table = await parseSampleTable(byteSource, stbl);
  if (!table) return null;

  const chapters = [];
  for (let i = 0; i < table.totalSamples; i++) {
    // eslint-disable-next-line no-await-in-loop
    const title = await readTextSample(byteSource, table.sampleOffsets[i], table.sampleSizes[i]);
    chapters.push({ title, start: table.sampleStarts[i] / timescale });
  }
  return chapters;
}

// Neither embedded format stores a chapter's end time directly (unlike the
// sidecar JSON, which gets it from ffprobe) — only where the NEXT chapter
// starts. Without an `end`, updateScrubber() (app.js) can't tell where the
// current chapter stops and falls back to the whole file's duration, which
// is what made the scrubber look like it spanned the entire book instead of
// just the current chapter. The last chapter is deliberately left without
// an `end` — that fallback-to-full-duration behavior is exactly correct for
// it, since its real end IS the end of the file.
function withDerivedEndTimes(chapters) {
  return chapters.map((c, i) => (i + 1 < chapters.length ? { ...c, end: chapters[i + 1].start } : c));
}

// ---- Entry point ------------------------------------------------------

export async function parseChaptersFromByteSource(byteSource) {
  try {
    const top = await walkBoxes(byteSource, 0, byteSource.length);
    const moov = top.find((b) => b.type === 'moov');
    if (!moov) {
      logDebug('mp4-chapters: no moov box found in this file.');
      return null;
    }
    const moovR = childRange(moov);
    const moovChildren = await walkBoxes(byteSource, moovR.start, moovR.end);

    // 1) Nero-style "chpl" atom, if present — simplest case.
    const udta = moovChildren.find((b) => b.type === 'udta');
    if (udta) {
      const udtaR = childRange(udta);
      const udtaChildren = await walkBoxes(byteSource, udtaR.start, udtaR.end);
      const chpl = udtaChildren.find((b) => b.type === 'chpl');
      if (chpl) {
        const chapters = await parseChplBox(byteSource, chpl);
        if (chapters.length) {
          logDebug(`mp4-chapters: found ${chapters.length} chapter(s) via the "chpl" atom.`);
          return { chapters: withDerivedEndTimes(chapters) };
        }
      }
    }

    // 2) QuickTime chapter text-track method: find the trak whose "tref"
    // has a "chap" entry, resolve the referenced track by ID.
    const trakBoxes = moovChildren.filter((b) => b.type === 'trak');
    for (const trak of trakBoxes) {
      // eslint-disable-next-line no-await-in-loop
      const tref = await findChildByPath(byteSource, trak, ['tref']);
      if (!tref) continue;
      // eslint-disable-next-line no-await-in-loop
      const trefR = childRange(tref);
      // eslint-disable-next-line no-await-in-loop
      const trefChildren = await walkBoxes(byteSource, trefR.start, trefR.end);
      const chap = trefChildren.find((b) => b.type === 'chap');
      if (!chap) continue;

      const chapR = childRange(chap);
      // eslint-disable-next-line no-await-in-loop
      const refData = await readBytes(byteSource, chapR.start, chapR.end);
      const chapterTrackId = refData.getUint32(0);

      for (const candidate of trakBoxes) {
        // eslint-disable-next-line no-await-in-loop
        const id = await getTrackId(byteSource, candidate);
        if (id !== chapterTrackId) continue;
        // eslint-disable-next-line no-await-in-loop
        const chapters = await parseChapterTextTrack(byteSource, candidate);
        if (chapters && chapters.length) {
          logDebug(`mp4-chapters: found ${chapters.length} chapter(s) via the QuickTime chapter text-track method.`);
          return { chapters: withDerivedEndTimes(chapters) };
        }
      }
    }

    logDebug('mp4-chapters: no embedded chapter atom or chapter track found in this file.');
    return null;
  } catch (err) {
    logDebug(`mp4-chapters: parsing failed: ${err}`);
    return null;
  }
}
