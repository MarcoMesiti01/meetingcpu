import { describe, expect, it, vi } from "vitest";
import { BrowserAudioRecorder } from "./recorder";

describe("BrowserAudioRecorder", () => {
  it("requests microphone access and returns a webm blob when stopped", async () => {
    const stream = createStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const recorderCtor = createFakeMediaRecorder();
    const recorder = new BrowserAudioRecorder(getUserMedia, recorderCtor);

    await recorder.start();
    const blob = await recorder.stop();

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(blob.type).toBe("audio/webm");
  });

  it("rejects stop before start", async () => {
    const recorder = new BrowserAudioRecorder(vi.fn(), createFakeMediaRecorder());

    await expect(recorder.stop()).rejects.toThrow("Recording has not started.");
  });

  it("guards repeated start while recording", async () => {
    const stream = createStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const recorder = new BrowserAudioRecorder(getUserMedia, createFakeMediaRecorder());

    await recorder.start();

    await expect(recorder.start()).rejects.toThrow("Recording is already in progress.");
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("guards overlapping starts while microphone access is pending", async () => {
    const stream = createStream();
    const pendingMicrophone = createDeferred<MediaStream>();
    const getUserMedia = vi.fn().mockReturnValue(pendingMicrophone.promise);
    const recorder = new BrowserAudioRecorder(getUserMedia, createFakeMediaRecorder());

    const firstStart = recorder.start();

    await expect(recorder.start()).rejects.toThrow("Recording is already in progress.");
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    pendingMicrophone.resolve(stream);
    await firstStart;
    await recorder.stop();
  });

  it("clears the start guard when microphone access fails", async () => {
    const stream = createStream();
    const getUserMedia = vi.fn()
      .mockRejectedValueOnce(new Error("microphone denied"))
      .mockResolvedValueOnce(stream);
    const recorder = new BrowserAudioRecorder(getUserMedia, createFakeMediaRecorder());

    await expect(recorder.start()).rejects.toThrow("microphone denied");

    await recorder.start();
    await recorder.stop();

    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it("cleans up tracks when recorder construction fails", async () => {
    const stream = createStream();
    const retryStream = createStream();
    const getUserMedia = vi.fn()
      .mockResolvedValueOnce(stream)
      .mockResolvedValueOnce(retryStream);
    const FakeMediaRecorder = createFakeMediaRecorder();
    let constructionCount = 0;
    class RecorderCtor extends FakeMediaRecorder {
      constructor(nextStream: MediaStream) {
        constructionCount += 1;
        if (constructionCount === 1) {
          throw new Error("unsupported recorder");
        }
        super(nextStream);
      }
    }
    const recorder = new BrowserAudioRecorder(getUserMedia, RecorderCtor);

    await expect(recorder.start()).rejects.toThrow("unsupported recorder");

    expect(stream.stop).toHaveBeenCalledTimes(1);
    await expect(recorder.stop()).rejects.toThrow("Recording has not started.");

    await recorder.start();
    await recorder.stop();
    expect(retryStream.stop).toHaveBeenCalledTimes(1);
  });

  it("cleans up tracks when recorder start fails", async () => {
    const stream = createStream();
    const retryStream = createStream();
    const getUserMedia = vi.fn()
      .mockResolvedValueOnce(stream)
      .mockResolvedValueOnce(retryStream);
    const recorder = new BrowserAudioRecorder(
      getUserMedia,
      createFakeMediaRecorder({ startErrorOnce: new Error("start failed") })
    );

    await expect(recorder.start()).rejects.toThrow("start failed");

    expect(stream.stop).toHaveBeenCalledTimes(1);
    await expect(recorder.stop()).rejects.toThrow("Recording has not started.");

    await recorder.start();
    await recorder.stop();
    expect(retryStream.stop).toHaveBeenCalledTimes(1);
  });

  it("cleans up state after stop so stop is not repeatable and recording can restart", async () => {
    const firstStream = createStream();
    const secondStream = createStream();
    const getUserMedia = vi.fn()
      .mockResolvedValueOnce(firstStream)
      .mockResolvedValueOnce(secondStream);
    const recorder = new BrowserAudioRecorder(getUserMedia, createFakeMediaRecorder());

    await recorder.start();
    await recorder.stop();

    expect(firstStream.stop).toHaveBeenCalledTimes(1);
    await expect(recorder.stop()).rejects.toThrow("Recording has not started.");

    await recorder.start();
    await recorder.stop();

    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(secondStream.stop).toHaveBeenCalledTimes(1);
  });

  it("captures dataavailable chunks emitted during stop", async () => {
    const stream = createStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const recorder = new BrowserAudioRecorder(getUserMedia, createFakeMediaRecorder({
      emitDataOnStart: false,
      emitDataOnStop: true
    }));

    await recorder.start();
    const blob = await recorder.stop();

    expect(await readBlobAsText(blob)).toBe("audio");
    expect(blob.type).toBe("audio/webm");
  });

  it("starts chunked recording with overlap cadence and emits clock-based chunk metadata", async () => {
    const stream = createStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const recorderCtor = createFakeMediaRecorder({ emitDataOnStart: false, mimeType: "audio/webm;codecs=opus" });
    let now = 1_000;
    const recorder = new BrowserAudioRecorder(getUserMedia, recorderCtor, () => now);
    const chunks: unknown[] = [];

    await recorder.startChunked({ chunkSeconds: 2, overlapSeconds: 0.5, onChunk: (chunk) => chunks.push(chunk) });
    const instance = recorderCtor.instances[0];
    now = 2_250;
    instance.emitAudio("first");
    now = 4_750;
    instance.emitAudio("second");

    expect(instance.startCalls).toEqual([1500]);
    expect(chunks[0]).toHaveProperty("blob");
    expect(await readBlobAsText((chunks[0] as { blob: Blob }).blob)).toBe("first");
    expect(chunks).toMatchObject([
      {
        chunkIndex: 1,
        startSeconds: 0,
        endSeconds: 1.25,
        overlapSeconds: 0.5,
        mimeType: "audio/webm;codecs=opus",
        fileExtension: "webm",
        fileName: "chunk-000001.webm"
      },
      {
        chunkIndex: 2,
        startSeconds: 1.25,
        endSeconds: 3.75,
        overlapSeconds: 0.5,
        mimeType: "audio/webm;codecs=opus",
        fileExtension: "webm",
        fileName: "chunk-000002.webm"
      }
    ]);

    await recorder.stop();
  });

  it("uses a 25 second overlap cadence by default for chunked recording", async () => {
    const stream = createStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const recorderCtor = createFakeMediaRecorder({ emitDataOnStart: false });
    const recorder = new BrowserAudioRecorder(getUserMedia, recorderCtor);
    const onChunk = vi.fn();

    await recorder.startChunked({ onChunk });
    recorderCtor.instances[0].emitAudio("audio");

    expect(recorderCtor.instances[0].startCalls).toEqual([25_000]);
    expect(onChunk).toHaveBeenCalledWith(expect.objectContaining({ overlapSeconds: 5 }));
    await recorder.stop();
  });

  it("preserves the full chunked recording on stop", async () => {
    const stream = createStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const recorderCtor = createFakeMediaRecorder({ emitDataOnStart: false });
    const recorder = new BrowserAudioRecorder(getUserMedia, recorderCtor);

    await recorder.startChunked({ chunkSeconds: 2, onChunk: vi.fn() });
    recorderCtor.instances[0].emitAudio("one");
    recorderCtor.instances[0].emitAudio("two");
    const blob = await recorder.stop();

    expect(await readBlobAsText(blob)).toBe("onetwo");
    expect(blob.type).toBe("audio/webm");
  });

  it("waits for pending chunk callbacks and the final stop chunk before resolving stop", async () => {
    const stream = createStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const recorderCtor = createFakeMediaRecorder({
      emitDataOnStart: false,
      emitDataOnStop: true
    });
    const recorder = new BrowserAudioRecorder(getUserMedia, recorderCtor);
    const firstChunk = createDeferred<void>();
    const finalChunk = createDeferred<void>();
    const onChunk = vi.fn()
      .mockReturnValueOnce(firstChunk.promise)
      .mockReturnValueOnce(finalChunk.promise);

    await recorder.startChunked({ chunkSeconds: 2, onChunk });
    recorderCtor.instances[0].emitAudio("first");

    const stopPromise = recorder.stop();
    let stopResolved = false;
    stopPromise.then(() => {
      stopResolved = true;
    });
    await Promise.resolve();

    expect(onChunk).toHaveBeenCalledTimes(2);
    expect(stopResolved).toBe(false);

    firstChunk.resolve();
    await Promise.resolve();
    expect(stopResolved).toBe(false);

    finalChunk.resolve();
    const blob = await stopPromise;

    expect(stopResolved).toBe(true);
    expect(await readBlobAsText(blob)).toBe("firstaudio");
    expect(stream.stop).toHaveBeenCalledTimes(1);
  });

  it("does not emit empty chunks during chunked recording", async () => {
    const stream = createStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const recorderCtor = createFakeMediaRecorder({ emitDataOnStart: false });
    const recorder = new BrowserAudioRecorder(getUserMedia, recorderCtor);
    const onChunk = vi.fn();

    await recorder.startChunked({ chunkSeconds: 2, onChunk });
    recorderCtor.instances[0].emitBlob(new Blob([], { type: "audio/webm" }));
    recorderCtor.instances[0].emitAudio("non-empty");

    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk.mock.calls[0][0].chunkIndex).toBe(1);
    await recorder.stop();
  });

  it("guards overlapping single-blob and chunked starts", async () => {
    const stream = createStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const recorder = new BrowserAudioRecorder(getUserMedia, createFakeMediaRecorder({ emitDataOnStart: false }));

    await recorder.startChunked({ chunkSeconds: 2, onChunk: vi.fn() });

    await expect(recorder.start()).rejects.toThrow("Recording is already in progress.");
    await expect(recorder.startChunked({ chunkSeconds: 2, onChunk: vi.fn() })).rejects.toThrow(
      "Recording is already in progress."
    );
    await recorder.stop();
  });

  it("cleans up tracks and rejects stop with the chunk callback error when callbacks fail", async () => {
    const stream = createStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const recorderCtor = createFakeMediaRecorder({ emitDataOnStart: false });
    const recorder = new BrowserAudioRecorder(getUserMedia, recorderCtor);
    const uploadError = new Error("upload failed");

    await recorder.startChunked({
      chunkSeconds: 2,
      onChunk: () => Promise.reject(uploadError)
    });
    recorderCtor.instances[0].emitAudio("audio");

    await expect(recorder.stop()).rejects.toThrow("upload failed");
    expect(stream.stop).toHaveBeenCalledTimes(1);
  });

  it("waits for all pending chunk callbacks before rejecting stop when one fails", async () => {
    const stream = createStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const recorderCtor = createFakeMediaRecorder({ emitDataOnStart: false });
    const recorder = new BrowserAudioRecorder(getUserMedia, recorderCtor);
    const failedChunk = createDeferred<void>();
    const slowChunk = createDeferred<void>();
    const uploadError = new Error("upload failed");
    const onChunk = vi.fn()
      .mockReturnValueOnce(failedChunk.promise)
      .mockReturnValueOnce(slowChunk.promise);

    await recorder.startChunked({ chunkSeconds: 2, onChunk });
    recorderCtor.instances[0].emitAudio("first");
    recorderCtor.instances[0].emitAudio("second");

    const stopPromise = recorder.stop();
    let stopRejected = false;
    stopPromise.catch(() => {
      stopRejected = true;
    });
    await Promise.resolve();

    failedChunk.reject(uploadError);
    await waitForAsyncTurn();

    expect(stopRejected).toBe(false);

    slowChunk.resolve();

    await expect(stopPromise).rejects.toThrow("upload failed");
    expect(stopRejected).toBe(true);
    expect(stream.stop).toHaveBeenCalledTimes(1);
  });

  it("waits for a pending rejection and final stop chunk before rejecting stop", async () => {
    const stream = createStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const recorderCtor = createFakeMediaRecorder({
      emitDataOnStart: false,
      emitDataOnStop: true
    });
    const recorder = new BrowserAudioRecorder(getUserMedia, recorderCtor);
    const failedChunk = createDeferred<void>();
    const finalChunk = createDeferred<void>();
    const uploadError = new Error("upload failed");
    const onChunk = vi.fn()
      .mockReturnValueOnce(failedChunk.promise)
      .mockReturnValueOnce(finalChunk.promise);

    await recorder.startChunked({ chunkSeconds: 2, onChunk });
    recorderCtor.instances[0].emitAudio("first");

    const stopPromise = recorder.stop();
    let stopRejected = false;
    stopPromise.catch(() => {
      stopRejected = true;
    });
    await Promise.resolve();

    expect(onChunk).toHaveBeenCalledTimes(2);

    failedChunk.reject(uploadError);
    await waitForAsyncTurn();

    expect(stopRejected).toBe(false);

    finalChunk.resolve();

    await expect(stopPromise).rejects.toThrow("upload failed");
    expect(stopRejected).toBe(true);
    expect(stream.stop).toHaveBeenCalledTimes(1);
  });
});

function createStream() {
  const stop = vi.fn();
  return {
    stop,
    getTracks: () => [{ stop }]
  } as unknown as MediaStream & { stop: ReturnType<typeof vi.fn> };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

function readBlobAsText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read blob."));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsText(blob);
  });
}

function waitForAsyncTurn(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function createFakeMediaRecorder(options: {
  emitDataOnStart?: boolean;
  emitDataOnStop?: boolean;
  mimeType?: string;
  startError?: Error;
  startErrorOnce?: Error;
} = {}) {
  const {
    emitDataOnStart = true,
    emitDataOnStop = false,
    mimeType = "audio/webm",
    startError,
    startErrorOnce
  } = options;
  let hasThrownStartErrorOnce = false;

  class FakeMediaRecorder {
    static instances: FakeMediaRecorder[] = [];
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    startCalls: Array<number | undefined> = [];

    constructor(public stream: MediaStream) {
      FakeMediaRecorder.instances.push(this);
    }

    start(timeslice?: number) {
      this.startCalls.push(timeslice);
      if (startError) throw startError;
      if (startErrorOnce && !hasThrownStartErrorOnce) {
        hasThrownStartErrorOnce = true;
        throw startErrorOnce;
      }
      if (emitDataOnStart) this.emitAudio();
    }

    stop() {
      if (emitDataOnStop) this.emitAudio();
      this.onstop?.();
    }

    emitAudio(contents = "audio") {
      this.emitBlob(new Blob([contents], { type: mimeType }));
    }

    emitBlob(blob: Blob) {
      this.ondataavailable?.({ data: blob });
    }
  }

  return FakeMediaRecorder as unknown as typeof MediaRecorder & { instances: FakeMediaRecorder[] };
}
