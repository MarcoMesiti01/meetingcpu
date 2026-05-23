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

  it("turns failed health responses into structured local errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ detail: { code: "SERVICE_UNHEALTHY", message: "Service is warming up." } })
    });

    const client = createTranscriptionClient("http://127.0.0.1:8765", fetchMock);
    await expect(client.health()).rejects.toMatchObject({
      code: "SERVICE_UNHEALTHY",
      status: 503,
      message: "Service is warming up."
    });
  });

  it("posts a transcription request and returns transcript data", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        text: "Hello.",
        language: "en",
        durationSeconds: 1.5,
        segments: [{ start: 0, end: 1.5, text: "Hello.", speaker: "Speaker 1" }],
        diarization: { available: true, enabled: true }
      })
    });

    const client = createTranscriptionClient("http://127.0.0.1:8765", fetchMock);
    const result = await client.transcribe({
      audioPath: "C:/meeting/data/sessions/recording.webm",
      modelId: "small",
      language: null,
      diarization: true
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/transcribe",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          audioPath: "C:/meeting/data/sessions/recording.webm",
          modelId: "small",
          language: null,
          diarization: true
        })
      })
    );
    expect(result.text).toBe("Hello.");
    expect(result.segments[0]).toMatchObject({ text: "Hello.", speaker: "Speaker 1" });
    expect(result).toMatchObject({ diarization: { available: true, enabled: true } });
  });

  it("preserves explicit disabled diarization in the transcription request body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        text: "Hello.",
        language: "en",
        durationSeconds: 1,
        segments: [{ start: 0, end: 1, text: "Hello." }],
        diarization: { available: false, enabled: false }
      })
    });

    const client = createTranscriptionClient("http://127.0.0.1:8765", fetchMock);
    await client.transcribe({
      audioPath: "C:/meeting/data/sessions/recording.webm",
      modelId: "small",
      language: null,
      diarization: false
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/transcribe",
      expect.objectContaining({
        body: JSON.stringify({
          audioPath: "C:/meeting/data/sessions/recording.webm",
          modelId: "small",
          language: null,
          diarization: false
        })
      })
    );
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

  it("turns rejected transcription fetches into structured unreachable errors", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:8765"));

    const client = createTranscriptionClient("http://127.0.0.1:8765", fetchMock);
    await expect(client.transcribe({ audioPath: "a.webm", modelId: "small", language: null })).rejects.toMatchObject({
      code: "TRANSCRIPTION_SERVICE_UNREACHABLE",
      status: 0,
      message: "Transcription service is unreachable: connect ECONNREFUSED 127.0.0.1:8765"
    });
  });

  it("turns malformed transcription responses into structured local errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        text: "Hello.",
        language: "en",
        durationSeconds: 1.5,
        segments: "not-segments"
      })
    });

    const client = createTranscriptionClient("http://127.0.0.1:8765", fetchMock);
    await expect(client.transcribe({ audioPath: "a.webm", modelId: "small", language: null })).rejects.toMatchObject({
      code: "TRANSCRIPTION_SERVICE_RESPONSE_INVALID",
      status: 502,
      message: "Transcription service returned an invalid transcription response."
    });
  });
});
