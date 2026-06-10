export interface UploadedAudioChunk {
  chunkIndex: number;
  startSeconds: number;
  endSeconds: number;
  overlapSeconds: number;
  blob: Blob;
  mimeType: string;
  fileExtension: string;
  fileName: string;
}

export interface UploadChunkerOptions {
  chunkSeconds?: number;
  overlapSeconds?: number;
  maxFileBytes?: number;
}

type AudioContextCtor = new () => AudioContext;

const DEFAULT_CHUNK_SECONDS = 30;
const DEFAULT_OVERLAP_SECONDS = 5;
const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
const WAV_MIME_TYPE = "audio/wav";
const UNSUPPORTED_DECODE_MESSAGE = "This audio format is not supported by your browser on this machine.";

export class BrowserUploadChunker {
  constructor(private readonly AudioContextCtor?: AudioContextCtor) {}

  async chunkFile(file: File, options: UploadChunkerOptions = {}): Promise<UploadedAudioChunk[]> {
    const { chunkSeconds, overlapSeconds, maxFileBytes } = validateOptions(options);
    if (file.size > maxFileBytes) {
      throw new Error(`Uploaded files must be ${formatMegabytes(maxFileBytes)} or smaller.`);
    }
    const AudioContextImplementation = this.AudioContextCtor ?? getDefaultAudioContextCtor();
    if (!AudioContextImplementation) {
      throw new Error(UNSUPPORTED_DECODE_MESSAGE);
    }

    const context = new AudioContextImplementation();
    try {
      const audioBuffer = await decodeFile(context, file);
      return buildChunks(audioBuffer, chunkSeconds, overlapSeconds);
    } finally {
      await context.close().catch(() => undefined);
    }
  }
}

async function decodeFile(context: AudioContext, file: File): Promise<AudioBuffer> {
  let fileData: ArrayBuffer;
  try {
    fileData = await readFileData(file);
  } catch (error) {
    throw new Error(`Could not read uploaded audio file.${error instanceof Error && error.message ? ` ${error.message}` : ""}`);
  }

  try {
    return await context.decodeAudioData(fileData);
  } catch {
    throw new Error(UNSUPPORTED_DECODE_MESSAGE);
  }
}

function readFileData(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") {
    return file.arrayBuffer();
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("error", () => reject(reader.error ?? new Error("FileReader failed.")));
    reader.addEventListener("load", () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
        return;
      }
      reject(new Error("FileReader did not return binary audio data."));
    });
    reader.readAsArrayBuffer(file);
  });
}

function buildChunks(audioBuffer: AudioBuffer, chunkSeconds: number, overlapSeconds: number): UploadedAudioChunk[] {
  if (audioBuffer.duration <= 0) {
    return [];
  }

  const chunks: UploadedAudioChunk[] = [];
  const hopSeconds = chunkSeconds - overlapSeconds;

  for (let startSeconds = 0, chunkIndex = 1; startSeconds < audioBuffer.duration; startSeconds += hopSeconds, chunkIndex += 1) {
    const endSeconds = Math.min(audioBuffer.duration, startSeconds + chunkSeconds);
    chunks.push({
      chunkIndex,
      startSeconds,
      endSeconds,
      overlapSeconds: chunkIndex === 1 ? 0 : Math.min(overlapSeconds, Math.max(0, endSeconds - startSeconds)),
      blob: encodeWav(audioBuffer, startSeconds, endSeconds),
      mimeType: WAV_MIME_TYPE,
      fileExtension: "wav",
      fileName: `chunk-${chunkIndex.toString().padStart(6, "0")}.wav`
    });
  }

  return chunks;
}

function encodeWav(audioBuffer: AudioBuffer, startSeconds: number, endSeconds: number): Blob {
  const sampleRate = audioBuffer.sampleRate;
  const startFrame = Math.floor(startSeconds * sampleRate);
  const endFrame = Math.min(audioBuffer.length, Math.ceil(endSeconds * sampleRate));
  const frameCount = Math.max(0, endFrame - startFrame);
  const channelCount = audioBuffer.numberOfChannels;
  const bytesPerSample = 2;
  const dataSize = frameCount * channelCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  const channelData = Array.from({ length: channelCount }, (_value, channelIndex) => audioBuffer.getChannelData(channelIndex));
  let offset = 44;
  for (let frame = startFrame; frame < endFrame; frame += 1) {
    for (const channel of channelData) {
      const sample = Math.max(-1, Math.min(1, channel[frame] ?? 0));
      const encoded = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, encoded, true);
      offset += bytesPerSample;
    }
  }

  return new Blob([buffer], { type: WAV_MIME_TYPE });
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function validateOptions(options: UploadChunkerOptions): { chunkSeconds: number; overlapSeconds: number; maxFileBytes: number } {
  const chunkSeconds = options.chunkSeconds ?? DEFAULT_CHUNK_SECONDS;
  const overlapSeconds = options.overlapSeconds ?? DEFAULT_OVERLAP_SECONDS;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  if (!Number.isFinite(chunkSeconds) || chunkSeconds <= 0) {
    throw new Error("chunkSeconds must be a finite number greater than 0.");
  }
  if (!Number.isFinite(overlapSeconds) || overlapSeconds < 0) {
    throw new Error("overlapSeconds must be a finite number greater than or equal to 0.");
  }
  if (!Number.isFinite(maxFileBytes) || maxFileBytes <= 0) {
    throw new Error("maxFileBytes must be a finite number greater than 0.");
  }
  if (overlapSeconds >= chunkSeconds) {
    throw new Error("overlapSeconds must be less than chunkSeconds.");
  }

  return { chunkSeconds, overlapSeconds, maxFileBytes };
}

function getDefaultAudioContextCtor(): AudioContextCtor | undefined {
  const globalScope = globalThis as typeof globalThis & { webkitAudioContext?: AudioContextCtor };
  return globalScope.AudioContext ?? globalScope.webkitAudioContext;
}

function formatMegabytes(byteCount: number): string {
  return `${Math.round(byteCount / (1024 * 1024))} MB`;
}
