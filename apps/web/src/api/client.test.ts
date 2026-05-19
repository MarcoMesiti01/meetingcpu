import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "./client";

describe("api client", () => {
  it("loads models", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ defaultModelId: "small", models: [{ id: "small" }] })
    });

    const client = createApiClient(fetchMock);
    await expect(client.getModels()).resolves.toEqual({ defaultModelId: "small", models: [{ id: "small" }] });
  });

  it("submits audio as multipart form data", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sessionId: "session-1", transcript: { text: "Done" } })
    });
    const client = createApiClient(fetchMock);
    const audio = new Blob(["audio"], { type: "audio/webm" });

    await client.transcribeAudio({
      audio,
      fileName: "recording.webm",
      modelId: "small",
      sourceType: "microphone",
      title: "Meeting"
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/transcriptions", expect.objectContaining({
      method: "POST",
      body: expect.any(FormData)
    }));
    const [, options] = fetchMock.mock.calls[0];
    const form = options.body as FormData;
    expect(form.get("modelId")).toBe("small");
    expect(form.get("sourceType")).toBe("microphone");
    expect(form.get("title")).toBe("Meeting");
    expect(form.get("audio")).toBeInstanceOf(Blob);
  });

  it("uses backend transcription error messages when present", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ message: "Model is unavailable." })
    });
    const client = createApiClient(fetchMock);

    await expect(client.transcribeAudio(createInput())).rejects.toThrow("Model is unavailable.");
  });

  it("falls back for non-json transcription error responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      }
    });
    const client = createApiClient(fetchMock);

    await expect(client.transcribeAudio(createInput())).rejects.toThrow("Transcription failed.");
  });

  it("falls back for empty transcription error messages", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ message: "" })
    });
    const client = createApiClient(fetchMock);

    await expect(client.transcribeAudio(createInput())).rejects.toThrow("Transcription failed.");
  });

  it("normalizes transcription fetch failures", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const client = createApiClient(fetchMock);

    await expect(client.transcribeAudio(createInput())).rejects.toThrow("Transcription failed.");
  });

  it("uses backend model loading error messages when present", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ message: "Whisper service is offline." })
    });
    const client = createApiClient(fetchMock);

    await expect(client.getModels()).rejects.toThrow("Whisper service is offline.");
  });

  it("falls back for non-json model loading errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      }
    });
    const client = createApiClient(fetchMock);

    await expect(client.getModels()).rejects.toThrow("Could not load model options.");
  });

  it("normalizes model loading fetch failures", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const client = createApiClient(fetchMock);

    await expect(client.getModels()).rejects.toThrow("Could not load model options.");
  });
});

function createInput() {
  return {
    audio: new Blob(["audio"], { type: "audio/webm" }),
    fileName: "recording.webm",
    modelId: "small",
    sourceType: "microphone" as const,
    title: "Meeting"
  };
}
