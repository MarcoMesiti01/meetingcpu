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

  it("creates chunked transcription sessions", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        sessionId: "session-1",
        sessionPath: "/sessions/session-1",
        inProgressTranscriptPath: "/sessions/session-1/transcript.in-progress.txt"
      })
    });
    const client = createApiClient(fetchMock);

    await expect(
      client.createSession({ title: "Planning", modelId: "small", language: "en", diarization: true })
    ).resolves.toMatchObject({ sessionId: "session-1" });

    expect(fetchMock).toHaveBeenCalledWith("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Planning", modelId: "small", language: "en", diarization: true })
    });
  });

  it("uploads session chunks as multipart form data", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sessionId: "session-1", chunkIndex: 1, status: "queued" })
    });
    const client = createApiClient(fetchMock);
    const audio = new Blob(["audio"], { type: "audio/webm" });

    await client.uploadSessionChunk({
      sessionId: "session-1",
      audio,
      fileName: "chunk-000001.webm",
      chunkIndex: 1,
      startSeconds: 0,
      endSeconds: 30,
      overlapSeconds: 5,
      modelId: "small",
      sourceType: "microphone",
      mimeType: "audio/webm"
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/chunks", expect.objectContaining({
      method: "POST",
      body: expect.any(FormData)
    }));
    const [, options] = fetchMock.mock.calls[0];
    const form = options.body as FormData;
    expect(form.get("audio")).toBeInstanceOf(Blob);
    expect(form.get("chunkIndex")).toBe("1");
    expect(form.get("startSeconds")).toBe("0");
    expect(form.get("endSeconds")).toBe("30");
    expect(form.get("overlapSeconds")).toBe("5");
    expect(form.get("modelId")).toBe("small");
    expect(form.get("sourceType")).toBe("microphone");
    expect(form.get("mimeType")).toBe("audio/webm");
  });

  it("finalizes chunked transcription sessions", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        sessionId: "session-1",
        transcriptPath: "/sessions/session-1/transcript.txt",
        transcriptJsonPath: "/sessions/session-1/transcript.json",
        partial: false
      })
    });
    const client = createApiClient(fetchMock);

    await expect(client.finalizeSession("session-1")).resolves.toMatchObject({ partial: false });
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session-1/finalize", { method: "POST" });
  });

  it("normalizes chunk session error responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ message: "Session was not found." })
    });
    const client = createApiClient(fetchMock);

    await expect(client.finalizeSession("missing")).rejects.toThrow("Session was not found.");
  });

  it("subscribes to session events and parses event payloads", () => {
    const EventSourceCtor = createFakeEventSource();
    const client = createApiClient(vi.fn(), EventSourceCtor);
    const onEvent = vi.fn();

    const connection = client.subscribeToSessionEvents("session-1", { onEvent });
    EventSourceCtor.instances[0].emit("chunk-transcribed", {
      type: "chunk-transcribed",
      sessionId: "session-1",
      chunkIndex: 1,
      text: "Hello",
      diarization: { available: false, enabled: false }
    });

    expect(EventSourceCtor.instances[0].url).toBe("/api/sessions/session-1/events");
    expect(onEvent).toHaveBeenCalledWith({
      type: "chunk-transcribed",
      sessionId: "session-1",
      chunkIndex: 1,
      text: "Hello",
      diarization: { available: false, enabled: false }
    });

    connection.close();
    expect(EventSourceCtor.instances[0].close).toHaveBeenCalledTimes(1);
  });

  it("reports session event parse and stream errors", () => {
    const EventSourceCtor = createFakeEventSource();
    const client = createApiClient(vi.fn(), EventSourceCtor);
    const onError = vi.fn();

    client.subscribeToSessionEvents("session-1", { onEvent: vi.fn(), onError });
    EventSourceCtor.instances[0].emitRaw("chunk-saved", "{not-json");
    EventSourceCtor.instances[0].onerror?.(new Event("error"));

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(onError).toHaveBeenCalledWith(new Error("Session event stream failed."));
  });

  it("does not report onEvent exceptions as session event parse failures", () => {
    const EventSourceCtor = createFakeEventSource();
    const client = createApiClient(vi.fn(), EventSourceCtor);
    const onError = vi.fn();
    const handlerError = new Error("handler failed");

    client.subscribeToSessionEvents("session-1", {
      onEvent: () => {
        throw handlerError;
      },
      onError
    });

    EventSourceCtor.instances[0].emit("chunk-saved", {
      type: "chunk-saved",
      sessionId: "session-1",
      chunkIndex: 1
    });

    expect(onError).toHaveBeenCalledWith(handlerError);
    expect(onError).not.toHaveBeenCalledWith(new Error("Could not parse session event."));
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

function createFakeEventSource() {
  class FakeEventSource {
    static instances: FakeEventSource[] = [];
    listeners = new Map<string, Array<(event: MessageEvent) => void>>();
    onerror: ((event: Event) => void) | null = null;
    close = vi.fn();

    constructor(public url: string) {
      FakeEventSource.instances.push(this);
    }

    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    emit(type: string, data: unknown) {
      this.emitRaw(type, JSON.stringify(data));
    }

    emitRaw(type: string, data: string) {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(new MessageEvent(type, { data }));
      }
    }
  }

  return FakeEventSource as unknown as typeof EventSource & { instances: FakeEventSource[] };
}
