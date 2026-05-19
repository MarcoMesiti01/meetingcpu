import { describe, expect, it, vi } from "vitest";
import { BrowserAudioRecorder } from "./recorder";

describe("BrowserAudioRecorder", () => {
  it("requests microphone access and returns a webm blob when stopped", async () => {
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const recorderCtor = createFakeMediaRecorder("audio/webm");
    const recorder = new BrowserAudioRecorder(getUserMedia, recorderCtor);

    await recorder.start();
    const blob = await recorder.stop();

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(blob.type).toBe("audio/webm");
  });
});

function createFakeMediaRecorder(mimeType: string) {
  return class FakeMediaRecorder {
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;

    constructor(public stream: MediaStream) {}

    start() {
      this.ondataavailable?.({ data: new Blob(["audio"], { type: mimeType }) });
    }

    stop() {
      this.onstop?.();
    }
  } as unknown as typeof MediaRecorder;
}
