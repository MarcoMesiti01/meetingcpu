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
  });
});
