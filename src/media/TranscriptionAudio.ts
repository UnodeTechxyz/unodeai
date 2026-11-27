import { hostToolRefusalDetail } from '../backend/toolSummary';

export const TRANSCRIPTION_MAX_BYTES = 25_000_000;
export const TRANSCRIPTION_MAX_SECONDS = 1_500;
// Fast speech can use about five output tokens per second. Four minutes leaves
// headroom below a 2,000-token response even at that pace.
export const TRANSCRIPTION_PART_SECONDS = 240;
export const TRANSCRIPTION_DURATION_MESSAGE = hostToolRefusalDetail(
  'Transcription accepts at most 1,500 seconds (25 minutes) per recording. Split the recording into parts of 25 minutes or less and transcribe each part.',
);

export type TranscriptionFormat = 'wav' | 'mp3';
export interface TranscriptionAudio {
  format: TranscriptionFormat;
  seconds: number;
}

export interface TranscriptionAudioPart {
  bytes: Buffer;
  startSeconds: number;
  endSeconds: number;
  leadingSeconds?: number;
}

function magic(bytes: Buffer, offset: number, value: string): boolean {
  return bytes.toString('latin1', offset, offset + value.length) === value;
}

function waveLayout(bytes: Buffer) {
  const declaredSize = bytes.readUInt32LE(4);
  const end = declaredSize === 0 ? bytes.length : Math.min(bytes.length, declaredSize + 8);
  let format: { sampleRate: number; channels: number; blockAlign: number; bits: number; tag: number } | undefined;
  let formatBytes: Buffer | undefined;
  let dataStart = 0;
  let dataBytes: number | undefined;
  let sampleFrames: number | undefined;
  let offset = 12;
  while (offset + 8 <= (dataBytes === undefined ? bytes.length : end)) {
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const next = start + size + (size & 1);
    if (magic(bytes, offset, 'data')) {
      if (dataBytes !== undefined) break;
      // A recorder may leave the final data size unset or finish with a partial sample frame.
      const unfinished = size === 0 || end <= start;
      dataStart = start;
      dataBytes = unfinished ? bytes.length - start : Math.min(size, end - start);
      if (unfinished || next > end) break;
    } else if (next > (dataBytes === undefined ? bytes.length : end)) {
      break;
    } else if (magic(bytes, offset, 'fmt ')) {
      if (format || size < 16) return undefined;
      formatBytes = bytes.subarray(start, start + size);
      let tag = bytes.readUInt16LE(start);
      // WAVE_FORMAT_EXTENSIBLE stores the subtype DWORD and the standard wave GUID suffix.
      if (tag === 0xfffe) {
        if (size < 40 || bytes.readUInt16LE(start + 16) < 22
          || bytes.toString('hex', start + 28, start + 40) !== '00001000800000aa00389b71') return undefined;
        tag = bytes.readUInt32LE(start + 24);
      }
      format = {
        tag,
        channels: bytes.readUInt16LE(start + 2),
        sampleRate: bytes.readUInt32LE(start + 4),
        blockAlign: bytes.readUInt16LE(start + 12),
        bits: bytes.readUInt16LE(start + 14),
      };
    } else if (magic(bytes, offset, 'fact') && size >= 4) {
      sampleFrames = bytes.readUInt32LE(start);
    }
    offset = next;
  }
  if (!format?.sampleRate || !format.tag || !format.channels || !format.blockAlign || !dataBytes || !formatBytes) return undefined;
  const fixedWidth = format.tag === 1 || format.tag === 3 || format.tag === 6 || format.tag === 7;
  if (fixedWidth) {
    const expectedAlign = format.channels * Math.ceil(format.bits / 8);
    if (format.blockAlign !== expectedAlign) return undefined;
    sampleFrames = Math.floor(dataBytes / format.blockAlign);
  }
  if (!sampleFrames) return undefined;
  return { ...format, formatBytes, dataStart, dataBytes, sampleFrames, fixedWidth };
}

function waveDuration(bytes: Buffer): number | undefined {
  const layout = waveLayout(bytes);
  return layout && layout.sampleFrames / layout.sampleRate;
}

const MPEG1_LAYER3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_LAYER3_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MPEG1_SAMPLE_RATES = [44_100, 48_000, 32_000];
// A common multiple of every Layer III sample rate keeps the exact 1,500 s boundary free of rounding drift.
const MP3_TICKS_PER_SECOND = 14_112_000;

function mp3FramesStart(bytes: Buffer): number | undefined {
  if (!magic(bytes, 0, 'ID3')) return 0;
  const version = bytes[3];
  if (bytes.length < 10 || version < 2 || version > 4) return undefined;
  let size = 0;
  for (const byte of bytes.subarray(6, 10)) {
    if (byte >= 128) return undefined; // ID3 tag length is stored in four 7-bit bytes.
    size = size * 128 + byte;
  }
  const footer = version === 4 && (bytes[5] & 16) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

function mp3Frame(bytes: Buffer, offset: number) {
  if (offset + 4 > bytes.length || bytes[offset] !== 0xff) return undefined;
  const header = bytes.readUInt32BE(offset);
  const version = (header >>> 19) & 3;
  if ((header >>> 21) !== 0x7ff || version === 1 || ((header >>> 17) & 3) !== 1) return undefined;
  const mpeg1 = version === 3;
  const rate = MPEG1_SAMPLE_RATES[(header >>> 10) & 3];
  const kbps = (mpeg1 ? MPEG1_LAYER3_KBPS : MPEG2_LAYER3_KBPS)[(header >>> 12) & 15];
  if (!rate || !kbps) return undefined;
  const sampleRate = rate / (mpeg1 ? 1 : version === 2 ? 2 : 4);
  const samples = mpeg1 ? 1_152 : 576;
  const mono = ((header >>> 6) & 3) === 3;
  const sideInfo = mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17);
  const sideStart = offset + ((header & (1 << 16)) ? 4 : 6);
  return {
    header,
    offset,
    next: offset + Math.floor(samples * kbps * 1_000 / (8 * sampleRate)) + ((header >>> 9) & 1),
    ticks: samples * (MP3_TICKS_PER_SECOND / sampleRate),
    mpeg1,
    sideStart,
    dataStart: sideStart + sideInfo,
  };
}

function* mp3Frames(bytes: Buffer) {
  const start = mp3FramesStart(bytes);
  if (start === undefined) return;
  let offset = start;
  while (offset < bytes.length && bytes[offset] === 0) offset++;
  let frame = mp3Frame(bytes, offset);
  // Consecutive headers distinguish audio from a stray sync word in a tag or a truncated first frame.
  if (!frame || !mp3Frame(bytes, frame.next)) return;
  while (frame && frame.next <= bytes.length) {
    yield frame;
    frame = mp3Frame(bytes, frame.next);
  }
}

function mp3Duration(bytes: Buffer): number | undefined {
  let ticks = 0;
  for (const frame of mp3Frames(bytes)) ticks += frame.ticks;
  return ticks > 0 ? ticks / MP3_TICKS_PER_SECOND : undefined;
}

type Mp3Frame = NonNullable<ReturnType<typeof mp3Frame>>;

function mp3Parts(bytes: Buffer): TranscriptionAudioPart[] {
  const sourceFrames = [...mp3Frames(bytes)];
  const audioFrames = sourceFrames.map((frame, sourceIndex) => ({ ...frame, sourceIndex })).filter(frame => !(
    (frame.dataStart + 4 <= frame.next && (magic(bytes, frame.dataStart, 'Xing') || magic(bytes, frame.dataStart, 'Info')))
    || (frame.offset + 40 <= frame.next && magic(bytes, frame.offset + 36, 'VBRI'))));
  const limit = TRANSCRIPTION_PART_SECONDS * MP3_TICKS_PER_SECOND;
  const parts: TranscriptionAudioPart[] = [];
  let start = 0;
  for (let first = 0; first < audioFrames.length;) {
    const initial = audioFrames[first];
    const primer = mp3ReservoirPrimer(bytes, sourceFrames, initial.sourceIndex);
    const leadingTicks = primer ? initial.ticks : 0;
    let ticks = 0;
    let end = first;
    while (end < audioFrames.length && leadingTicks + ticks + audioFrames[end].ticks <= limit) {
      ticks += audioFrames[end++].ticks;
    }
    // The ordinary MP3 validator requires two frames. Leave a pair for a one-frame tail.
    if (audioFrames.length - end === 1 && !mp3ReservoirSize(bytes, audioFrames[end])) {
      ticks -= audioFrames[--end].ticks;
    }
    parts.push(mp3Part(bytes, audioFrames.slice(first, end), start, ticks, primer, leadingTicks));
    start += ticks;
    first = end;
  }
  return parts;
}

function mp3ReservoirSize(bytes: Buffer, frame: Mp3Frame): number {
  if (frame.dataStart > frame.next) return 0;
  return frame.mpeg1 ? (bytes[frame.sideStart] << 1) | (bytes[frame.sideStart + 1] >>> 7) : bytes[frame.sideStart];
}

function mp3ReservoirPrimer(bytes: Buffer, sourceFrames: Mp3Frame[], index: number): Buffer | undefined {
  const frame = sourceFrames[index];
  let remaining = mp3ReservoirSize(bytes, frame);
  if (!index || !remaining) return undefined;

  // Layer III can reference main data from earlier frames. A silent frame with
  // zeroed side information carries that reservoir into the new stream.
  const header = Buffer.alloc(4);
  header.writeUInt32BE(((frame.header & ~0xf200) | 0xe000 | 0x10000) >>> 0);
  const primerLayout = mp3Frame(header, 0)!;
  const primer = Buffer.alloc(primerLayout.next);
  header.copy(primer);
  let end = primer.length;
  for (let i = index - 1; remaining && i >= 0; i--) {
    const previous = sourceFrames[i];
    const length = Math.min(remaining, Math.max(0, previous.next - previous.dataStart));
    bytes.copy(primer, end - length, previous.next - length, previous.next);
    end -= length;
    remaining -= length;
  }
  return primer;
}

function mp3Part(bytes: Buffer, frames: Mp3Frame[], start: number, ticks: number, primer: Buffer | undefined, leadingTicks: number): TranscriptionAudioPart {
  const runs: Buffer[] = primer ? [primer] : [];
  let runStart = frames[0].offset;
  let runEnd = runStart;
  for (const frame of frames) {
    if (frame.offset !== runEnd) {
      runs.push(bytes.subarray(runStart, runEnd));
      runStart = frame.offset;
    }
    runEnd = frame.next;
  }
  runs.push(bytes.subarray(runStart, runEnd));
  return { bytes: runs.length === 1 ? runs[0] : Buffer.concat(runs),
    startSeconds: start / MP3_TICKS_PER_SECOND, endSeconds: (start + ticks) / MP3_TICKS_PER_SECOND,
    ...(leadingTicks ? { leadingSeconds: leadingTicks / MP3_TICKS_PER_SECOND } : {}) };
}

function waveParts(bytes: Buffer, layout: NonNullable<ReturnType<typeof waveLayout>>): TranscriptionAudioPart[] | undefined {
  const { formatBytes, dataStart, dataBytes, sampleFrames, sampleRate, blockAlign } = layout;
  const blockCount = Math.floor(dataBytes / blockAlign);
  // Fixed-width WAV uses one sample frame per block. MS and IMA ADPCM
  // declare the samples per block in their format extension.
  const samplesPerBlock = layout.fixedWidth ? 1
    : (layout.tag === 2 || layout.tag === 17) && formatBytes.length >= 20 ? formatBytes.readUInt16LE(18) : 0;
  if (!samplesPerBlock || Math.ceil(sampleFrames / samplesPerBlock) !== blockCount) return undefined;
  const blocksPerPart = Math.floor(TRANSCRIPTION_PART_SECONDS * sampleRate / samplesPerBlock);
  if (!blocksPerPart) return undefined;
  const formatLength = 8 + formatBytes.length + (formatBytes.length & 1);
  const factLength = layout.tag === 1 ? 0 : 12;
  const parts: TranscriptionAudioPart[] = [];
  for (let first = 0; first < blockCount; first += blocksPerPart) {
    const end = Math.min(first + blocksPerPart, blockCount);
    const frames = Math.min(end * samplesPerBlock, sampleFrames) - first * samplesPerBlock;
    const data = bytes.subarray(dataStart + first * blockAlign, dataStart + end * blockAlign);
    const header = Buffer.alloc(12 + formatLength + factLength + 8);
    header.write('RIFF', 0);
    header.writeUInt32LE(header.length + data.length + (data.length & 1) - 8, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(formatBytes.length, 16);
    formatBytes.copy(header, 20);
    if (factLength) {
      header.write('fact', 12 + formatLength);
      header.writeUInt32LE(4, 16 + formatLength);
      header.writeUInt32LE(frames, 20 + formatLength);
    }
    header.write('data', header.length - 8);
    header.writeUInt32LE(data.length, header.length - 4);
    parts.push({ bytes: Buffer.concat([header, data, Buffer.alloc(data.length & 1)]),
      startSeconds: first * samplesPerBlock / sampleRate, endSeconds: (first * samplesPerBlock + frames) / sampleRate });
  }
  return parts;
}

/** Pass short recordings through unchanged. Split long recordings without re-encoding. */
export function splitTranscriptionAudio(bytes: Buffer, audio: TranscriptionAudio): TranscriptionAudioPart[] | undefined {
  if (audio.seconds <= TRANSCRIPTION_PART_SECONDS) return [{ bytes, startSeconds: 0, endSeconds: audio.seconds }];
  if (audio.format === 'mp3') return mp3Parts(bytes);
  const layout = waveLayout(bytes);
  return layout && waveParts(bytes, layout);
}

/** File names are presentation only. Validate the data and count sample frames before using the receiver. */
export function inspectTranscriptionAudio(bytes: Buffer): TranscriptionAudio | undefined {
  if (bytes.length >= 12 && magic(bytes, 0, 'RIFF') && magic(bytes, 8, 'WAVE')) {
    const seconds = waveDuration(bytes);
    return seconds === undefined ? undefined : { format: 'wav', seconds };
  }
  const seconds = mp3Duration(bytes);
  return seconds === undefined ? undefined : { format: 'mp3', seconds };
}
