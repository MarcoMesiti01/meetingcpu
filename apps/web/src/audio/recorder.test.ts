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

  it("cleans up tracks when recorder construction fails", async () => {
    const stream = createStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const RecorderCtor = vi.fn(() => {
      throw new Error("unsupported recorder");
    }) as unknown as typeof MediaRecorder;
    const recorder = new BrowserAudioRecorder(getUserMedia, RecorderCtor);

    await expect(recorder.start()).rejects.toThrow("unsupported recorder");

    expect(stream.stop).toHaveBeenCalledTimes(1);
    await expect(recorder.stop()).rejects.toThrow("Recording has not started.");
  });

  it("cleans up tracks when recorder start fails", async () => {
    const stream = createStream();
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const recorder = new BrowserAudioRecorder(getUserMedia, createFakeMediaRecorder({ startError: new Error("start failed") }));

    await expect(recorder.start()).rejects.toThrow("start failed");

    expect(stream.stop).toHaveBeenCalledTimes(1);
    await expect(recorder.stop()).rejects.toThrow("Recording has not started.");
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

    expect(await blob.text()).toBe("audio");
    expect(blob.type).toBe("audio/webm");
  });
});

function createStream() {
  const stop = vi.fn();
  return {
    stop,
    getTracks: () => [{ stop }]
  } as unknown as MediaStream & { stop: ReturnType<typeof vi.fn> };
}

function createFakeMediaRecorder(options: {
  emitDataOnStart?: boolean;
  emitDataOnStop?: boolean;
  mimeType?: string;
  startError?: Error;
} = {}) {
  const {
    emitDataOnStart = true,
    emitDataOnStop = false,
    mimeType = "audio/webm",
    startError
  } = options;

  return class FakeMediaRecorder {
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;

    constructor(public stream: MediaStream) {}

    start() {
      if (startError) throw startError;
      if (emitDataOnStart) this.emitAudio();
    }

    stop() {
      if (emitDataOnStop) this.emitAudio();
      this.onstop?.();
    }

    private emitAudio() {
      this.ondataavailable?.({ data: new Blob(["audio"], { type: mimeType }) });
    }
  } as unknown as typeof MediaRecorder;
}
