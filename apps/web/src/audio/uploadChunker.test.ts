import { describe, expect, it, vi } from "vitest";
import { BrowserUploadChunker } from "./uploadChunker";

describe("BrowserUploadChunker", () => {
  it("decodes an uploaded file into 30-second wav chunks with overlap metadata", async () => {
    const audioBuffer = createAudioBuffer({ durationSeconds: 65, sampleRate: 8000, channels: 1 });
    const AudioContextCtor = createAudioContext(audioBuffer);
    const chunker = new BrowserUploadChunker(AudioContextCtor);
    const file = new File([new Uint8Array([1, 2, 3])], "meeting.mp3", { type: "audio/mpeg" });

    const chunks = await chunker.chunkFile(file, { chunkSeconds: 30, overlapSeconds: 5 });

    expect(chunks).toHaveLength(3);
    expect(
      chunks.map((chunk) => ({
        chunkIndex: chunk.chunkIndex,
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds,
        overlapSeconds: chunk.overlapSeconds,
        mimeType: chunk.mimeType,
        fileName: chunk.fileName
      }))
    ).toEqual([
      {
        chunkIndex: 1,
        startSeconds: 0,
        endSeconds: 30,
        overlapSeconds: 0,
        mimeType: "audio/wav",
        fileName: "chunk-000001.wav"
      },
      {
        chunkIndex: 2,
        startSeconds: 25,
        endSeconds: 55,
        overlapSeconds: 5,
        mimeType: "audio/wav",
        fileName: "chunk-000002.wav"
      },
      {
        chunkIndex: 3,
        startSeconds: 50,
        endSeconds: 65,
        overlapSeconds: 5,
        mimeType: "audio/wav",
        fileName: "chunk-000003.wav"
      }
    ]);
    expect(chunks[0].blob.type).toBe("audio/wav");
    expect(await readHeader(chunks[0].blob)).toBe("RIFF");
    expect(AudioContextCtor.instances[0].close).toHaveBeenCalledTimes(1);
  });

  it("preserves file read failures as a distinct error", async () => {
    const AudioContextCtor = createAudioContext(createAudioBuffer({ durationSeconds: 1, sampleRate: 8000, channels: 1 }));
    const chunker = new BrowserUploadChunker(AudioContextCtor);
    const file = {
      arrayBuffer: vi.fn().mockRejectedValue(new Error("file read failed"))
    } as unknown as File;

    await expect(chunker.chunkFile(file)).rejects.toThrow("Could not read uploaded audio file.");
  });

  it("reports unsupported browser decoding with a clear error", async () => {
    const AudioContextCtor = createRejectingAudioContext(new DOMException("unsupported", "EncodingError"));
    const chunker = new BrowserUploadChunker(AudioContextCtor);
    const file = new File([new Uint8Array([1])], "meeting.xyz", { type: "application/octet-stream" });

    await expect(chunker.chunkFile(file)).rejects.toThrow(
      "This audio format is not supported by your browser on this machine."
    );
    expect(AudioContextCtor.instances[0].close).toHaveBeenCalledTimes(1);
  });

  it("uses FileReader when File.arrayBuffer is unavailable", async () => {
    const audioBuffer = createAudioBuffer({ durationSeconds: 1, sampleRate: 8000, channels: 1 });
    const AudioContextCtor = createAudioContext(audioBuffer);
    const chunker = new BrowserUploadChunker(AudioContextCtor);
    const file = new File([new Uint8Array([1, 2, 3])], "meeting.mp3", { type: "audio/mpeg" });

    expect(file.arrayBuffer).toBeUndefined();
    await expect(chunker.chunkFile(file)).resolves.toHaveLength(1);
    expect(AudioContextCtor.instances[0].decodeAudioData).toHaveBeenCalledWith(expect.any(ArrayBuffer));
  });

  it("rejects oversized uploads before reading or decoding", async () => {
    const AudioContextCtor = createAudioContext(createAudioBuffer({ durationSeconds: 1, sampleRate: 8000, channels: 1 }));
    const chunker = new BrowserUploadChunker(AudioContextCtor);
    const file = {
      size: 101 * 1024 * 1024,
      arrayBuffer: vi.fn()
    } as unknown as File;

    await expect(chunker.chunkFile(file)).rejects.toThrow("Uploaded files must be 100 MB or smaller.");
    expect(file.arrayBuffer).not.toHaveBeenCalled();
    expect(AudioContextCtor.instances).toHaveLength(0);
  });

  it("allows a larger upload when the file size guard is overridden", async () => {
    const AudioContextCtor = createAudioContext(createAudioBuffer({ durationSeconds: 1, sampleRate: 8000, channels: 1 }));
    const chunker = new BrowserUploadChunker(AudioContextCtor);
    const file = {
      size: 101 * 1024 * 1024,
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8))
    } as unknown as File;

    await expect(chunker.chunkFile(file, { maxFileBytes: 200 * 1024 * 1024 })).resolves.toHaveLength(1);
    expect(file.arrayBuffer).toHaveBeenCalledTimes(1);
    expect(AudioContextCtor.instances[0].close).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid chunk timing values including NaN and Infinity", async () => {
    const AudioContextCtor = createAudioContext(createAudioBuffer({ durationSeconds: 1, sampleRate: 8000, channels: 1 }));
    const chunker = new BrowserUploadChunker(AudioContextCtor);
    const file = new File([new Uint8Array([1])], "meeting.mp3", { type: "audio/mpeg" });

    await expect(chunker.chunkFile(file, { chunkSeconds: Number.NaN })).rejects.toThrow("chunkSeconds must be a finite number greater than 0.");
    await expect(chunker.chunkFile(file, { overlapSeconds: Number.POSITIVE_INFINITY })).rejects.toThrow("overlapSeconds must be a finite number greater than or equal to 0.");
  });
});

function createAudioBuffer(input: { durationSeconds: number; sampleRate: number; channels: number }): AudioBuffer {
  const length = input.durationSeconds * input.sampleRate;
  return {
    duration: input.durationSeconds,
    length,
    numberOfChannels: input.channels,
    sampleRate: input.sampleRate,
    getChannelData: () => {
      const data = new Float32Array(length);
      data.fill(0.25);
      return data;
    }
  } as AudioBuffer;
}

function createAudioContext(audioBuffer: AudioBuffer) {
  const instances: Array<{ decodeAudioData: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
  const FakeAudioContext = class {
    decodeAudioData = vi.fn().mockResolvedValue(audioBuffer);
    close = vi.fn().mockResolvedValue(undefined);
    constructor() {
      instances.push(this);
    }
  } as unknown as typeof AudioContext & { instances: typeof instances };
  (FakeAudioContext as typeof FakeAudioContext & { instances: typeof instances }).instances = instances;
  return FakeAudioContext as typeof AudioContext & { instances: typeof instances };
}

function createRejectingAudioContext(error: Error) {
  const instances: Array<{ decodeAudioData: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
  const FakeAudioContext = class {
    decodeAudioData = vi.fn().mockRejectedValue(error);
    close = vi.fn().mockResolvedValue(undefined);
    constructor() {
      instances.push(this);
    }
  } as unknown as typeof AudioContext & { instances: typeof instances };
  (FakeAudioContext as typeof FakeAudioContext & { instances: typeof instances }).instances = instances;
  return FakeAudioContext as typeof AudioContext & { instances: typeof instances };
}

async function readHeader(blob: Blob): Promise<string> {
  const reader = new FileReader();
  const data = await new Promise<ArrayBuffer>((resolve, reject) => {
    reader.addEventListener("error", () => reject(reader.error ?? new Error("FileReader failed.")));
    reader.addEventListener("load", () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
        return;
      }
      reject(new Error("FileReader did not return binary data."));
    });
    reader.readAsArrayBuffer(blob.slice(0, 4));
  });
  return new TextDecoder().decode(data);
}
