import { describe, expect, it, vi } from "vitest";
import { createTranscriptionClient } from "./transcriptionClient.js";

describe("transcription client", () => {
  it("returns health from the Python service", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, service: "meetingcpu-whisper" })
    });

    const client = createTranscriptionClient("http://127.0.0.1:8765", fetchMock);
    await expect(client.health()).resolves.toEqual({ ok: true, service: "meetingcpu-whisper" });
  });

  it("posts a transcription request and returns transcript data", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        text: "Hello.",
        language: "en",
        durationSeconds: 1.5,
        segments: [{ start: 0, end: 1.5, text: "Hello." }]
      })
    });

    const client = createTranscriptionClient("http://127.0.0.1:8765", fetchMock);
    const result = await client.transcribe({
      audioPath: "C:/meeting/data/sessions/recording.webm",
      modelId: "small",
      language: null
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/transcribe",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          audioPath: "C:/meeting/data/sessions/recording.webm",
          modelId: "small",
          language: null
        })
      })
    );
    expect(result.text).toBe("Hello.");
  });

  it("turns service failures into structured local errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ detail: { code: "MODEL_UNAVAILABLE", message: "Model is not available locally." } })
    });

    const client = createTranscriptionClient("http://127.0.0.1:8765", fetchMock);
    await expect(client.transcribe({ audioPath: "a.webm", modelId: "small", language: null })).rejects.toMatchObject({
      code: "MODEL_UNAVAILABLE",
      status: 503
    });
  });
});
