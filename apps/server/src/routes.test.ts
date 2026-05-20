import { access, mkdtemp, readFile, readdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { SessionEventHub } from "./sessionEvents.js";

describe("server routes", () => {
  it("lists model options", async () => {
    const app = createApp({
      dataRoot: await mkdtemp(join(tmpdir(), "meetingcpu-")),
      transcriptionClient: fakeTranscriptionClient()
    });

    const response = await request(app).get("/api/models").expect(200);
    expect(response.body.defaultModelId).toBe("small");
    expect(response.body.models.map((model: { id: string }) => model.id)).toContain("distil-large-v3");
  });

  it("sets CORS headers only for local browser origins", async () => {
    const app = createApp({
      dataRoot: await mkdtemp(join(tmpdir(), "meetingcpu-")),
      transcriptionClient: fakeTranscriptionClient()
    });

    await request(app)
      .get("/api/health")
      .set("Origin", "http://localhost:5173")
      .expect(200)
      .expect("Access-Control-Allow-Origin", "http://localhost:5173");

    const disallowed = await request(app).get("/api/health").set("Origin", "https://example.com").expect(200);
    expect(disallowed.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("saves a microphone recording and returns a transcript", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const transcribe = vi.fn().mockResolvedValue({
      text: "Local transcript.",
      language: "en",
      durationSeconds: 2,
      segments: [{ start: 0, end: 2, text: "Local transcript." }]
    });
    const app = createApp({
      dataRoot,
      transcriptionClient: { health: vi.fn(), transcribe }
    });

    const response = await request(app)
      .post("/api/transcriptions")
      .field("sourceType", "microphone")
      .field("modelId", "small")
      .field("title", "Planning")
      .attach("audio", Buffer.from("audio"), "recording.webm")
      .expect(201);

    expect(response.body.transcript.text).toBe("Local transcript.");
    expect(response.body.sessionId).toContain("planning");
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "small",
        language: null
      })
    );
    await expect(readFile(join(dataRoot, "sessions", response.body.sessionId, "recording.webm"), "utf8")).resolves.toBe(
      "audio"
    );
    await expect(readFile(join(dataRoot, "sessions", response.body.sessionId, "transcript.txt"), "utf8")).resolves.toBe(
      "Local transcript.\n"
    );
    await expect(readdir(join(dataRoot, "uploads", "tmp"))).resolves.toEqual([]);
  });

  it("creates chunked sessions with an in-progress transcript path", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const app = createApp({
      dataRoot,
      transcriptionClient: fakeTranscriptionClient()
    });

    const response = await request(app)
      .post("/api/sessions")
      .send({ title: "Live Planning", modelId: "small", language: "en", diarization: true })
      .expect(201);

    expect(response.body.sessionId).toContain("live-planning");
    expect(response.body.sessionPath).toBe(join(dataRoot, "sessions", response.body.sessionId));
    expect(response.body.inProgressTranscriptPath).toBe(
      join(dataRoot, "sessions", response.body.sessionId, "transcript.in-progress.txt")
    );
    await expect(readFile(response.body.inProgressTranscriptPath, "utf8")).resolves.toBe("");
  });

  it("streams session events as SSE with replayed session state", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const app = createApp({
      dataRoot,
      transcriptionClient: fakeTranscriptionClient()
    });
    const created = await request(app).post("/api/sessions").send({ title: "SSE", modelId: "small" }).expect(201);
    const server = await listen(app);
    const controller = new AbortController();

    try {
      const response = await fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/sessions/${created.body.sessionId}/events`,
        { signal: controller.signal }
      );
      const chunk = await response.body?.getReader().read();
      const text = new TextDecoder().decode(chunk?.value);
      const dataLine = text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length);
      const event = JSON.parse(dataLine ?? "{}");

      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(text).toContain("event: session-created\n");
      expect(event).toMatchObject({
        type: "session-created",
        sessionId: created.body.sessionId,
        inProgressTranscriptPath: created.body.inProgressTranscriptPath
      });
    } finally {
      controller.abort();
      await close(server);
    }
  });

  it("saves uploaded chunks, enqueues transcription, and finalizes the transcript", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const events = new SessionEventHub();
    const published: string[] = [];
    const transcribe = vi.fn().mockResolvedValue({
      text: "Hello chunk.",
      language: "en",
      durationSeconds: 2,
      segments: [{ start: 0, end: 2, text: "Hello chunk.", speaker: "Speaker 1" }],
      diarization: { available: true, enabled: true }
    });
    const app = createApp({
      dataRoot,
      transcriptionClient: { health: vi.fn(), transcribe },
      events
    });
    const created = await request(app)
      .post("/api/sessions")
      .send({ title: "Chunks", modelId: "small", language: "en", diarization: true })
      .expect(201);
    events.subscribe(created.body.sessionId, (event) => published.push(event.type));

    const chunkResponse = await request(app)
      .post(`/api/sessions/${created.body.sessionId}/chunks`)
      .field("chunkIndex", "1")
      .field("startSeconds", "0")
      .field("endSeconds", "2")
      .field("overlapSeconds", "0")
      .attach("audio", Buffer.from("chunk-audio"), "chunk.webm")
      .expect(202);

    expect(chunkResponse.body).toEqual({
      sessionId: created.body.sessionId,
      chunkIndex: 1,
      status: "queued"
    });

    const finalized = await request(app).post(`/api/sessions/${created.body.sessionId}/finalize`).expect(200);

    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "small",
        language: "en",
        diarization: true
      })
    );
    expect(published).toEqual(expect.arrayContaining(["chunk-saved", "chunk-transcribed", "session-finalized"]));
    await expect(readFile(created.body.inProgressTranscriptPath, "utf8")).resolves.toBe(
      "[00:00:00] Speaker 1: Hello chunk.\n"
    );
    await expect(readFile(finalized.body.transcriptPath, "utf8")).resolves.toBe("Hello chunk.\n");
    expect(finalized.body.partial).toBe(false);
  });

  it("records failed chunks, emits chunk-failed, and finalizes a partial transcript", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const events = new SessionEventHub();
    const published: unknown[] = [];
    const transcribe = vi
      .fn()
      .mockResolvedValueOnce({
        text: "Good chunk.",
        language: "en",
        durationSeconds: 2,
        segments: [{ start: 0, end: 2, text: "Good chunk." }],
        diarization: { available: false, enabled: false }
      })
      .mockRejectedValueOnce({ code: "MODEL_UNAVAILABLE", status: 503, message: "Model is unavailable." });
    const app = createApp({
      dataRoot,
      transcriptionClient: { health: vi.fn(), transcribe },
      events
    });
    const created = await request(app).post("/api/sessions").send({ title: "Partial", modelId: "small" }).expect(201);
    events.subscribe(created.body.sessionId, (event) => published.push(event));

    await request(app)
      .post(`/api/sessions/${created.body.sessionId}/chunks`)
      .field("chunkIndex", "1")
      .field("startSeconds", "0")
      .field("endSeconds", "2")
      .field("overlapSeconds", "0")
      .attach("audio", Buffer.from("chunk-audio-1"), "chunk-1.webm")
      .expect(202);
    await request(app)
      .post(`/api/sessions/${created.body.sessionId}/chunks`)
      .field("chunkIndex", "2")
      .field("startSeconds", "2")
      .field("endSeconds", "4")
      .field("overlapSeconds", "0")
      .attach("audio", Buffer.from("chunk-audio-2"), "chunk-2.webm")
      .expect(202);

    const finalized = await request(app).post(`/api/sessions/${created.body.sessionId}/finalize`).expect(200);

    expect(finalized.body.partial).toBe(true);
    await expect(readFile(finalized.body.transcriptPath, "utf8")).resolves.toBe("Good chunk.\n");
    expect(published).toContainEqual(
      expect.objectContaining({
        type: "chunk-failed",
        sessionId: created.body.sessionId,
        chunkIndex: 2,
        code: "MODEL_UNAVAILABLE",
        message: "Model is unavailable."
      })
    );
    const metadata = JSON.parse(await readFile(join(dataRoot, "sessions", created.body.sessionId, "metadata.json"), "utf8"));
    expect(metadata).toMatchObject({
      status: "transcribed-partial",
      partial: true,
      failedChunks: [{ chunkIndex: 2, code: "MODEL_UNAVAILABLE", message: "Model is unavailable." }]
    });
  });

  it("rejects unknown model ids before saving work", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const transcriptionClient = fakeTranscriptionClient();
    const app = createApp({
      dataRoot,
      transcriptionClient
    });

    const response = await request(app)
      .post("/api/transcriptions")
      .field("sourceType", "microphone")
      .field("modelId", "bad-model")
      .attach("audio", Buffer.from("audio"), "recording.webm")
      .expect(400);

    expect(response.body.code).toBe("UNKNOWN_MODEL");
    expect(response.body.suggestedModelIds).toEqual(["small", "base", "tiny"]);
    expect(transcriptionClient.transcribe).not.toHaveBeenCalled();
    await expect(access(join(dataRoot, "sessions"))).rejects.toThrow();
  });

  it("returns a controlled error when transcription fails after saving the recording", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const transcribe = vi.fn().mockRejectedValue({
      code: "MODEL_UNAVAILABLE",
      status: 503,
      message: "Model is not available locally."
    });
    const app = createApp({
      dataRoot,
      transcriptionClient: { health: vi.fn(), transcribe }
    });

    const response = await request(app)
      .post("/api/transcriptions")
      .field("sourceType", "microphone")
      .field("modelId", "small")
      .field("title", "Transcription failure")
      .attach("audio", Buffer.from("audio"), "recording.webm")
      .expect(503);

    expect(response.body.code).toBe("MODEL_UNAVAILABLE");
    const sessionId = response.body.sessionId;
    const sessionPath = join(dataRoot, "sessions", sessionId);
    await expect(readFile(join(sessionPath, "recording.webm"), "utf8")).resolves.toBe("audio");
    const metadata = JSON.parse(await readFile(join(sessionPath, "metadata.json"), "utf8"));
    expect(metadata).toMatchObject({
      status: "transcription-failed",
      sourceType: "microphone",
      modelId: "small",
      error: {
        code: "MODEL_UNAVAILABLE",
        message: "Model is not available locally."
      }
    });
    await expect(access(join(sessionPath, "transcript.txt"))).rejects.toThrow();
    await expect(access(join(sessionPath, "transcript.json"))).rejects.toThrow();
    await expect(readdir(join(dataRoot, "uploads", "tmp"))).resolves.toEqual([]);
  });

  it("returns a controlled error for upload chunking when ffmpeg is unavailable", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const transcriptionClient = fakeTranscriptionClient();
    const app = createApp({
      dataRoot,
      transcriptionClient
    });

    const response = await request(app)
      .post("/api/transcriptions")
      .field("sourceType", "upload")
      .field("modelId", "small")
      .attach("audio", Buffer.from("audio"), "meeting.mp3")
      .expect(501);

    expect(response.body).toEqual({
      code: "UPLOAD_CHUNKING_UNAVAILABLE",
      message: "Upload chunking requires ffmpeg. Install ffmpeg or set FFMPEG_PATH."
    });
    expect(transcriptionClient.transcribe).not.toHaveBeenCalled();
  });

  it("returns a controlled error when uploads exceed the size limit", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const app = createApp({
      dataRoot,
      transcriptionClient: fakeTranscriptionClient(),
      maxAudioUploadBytes: 4
    });

    const response = await request(app)
      .post("/api/transcriptions")
      .field("sourceType", "microphone")
      .field("modelId", "small")
      .attach("audio", Buffer.from("audio-too-large"), "recording.webm")
      .expect(413);

    expect(response.body).toEqual({
      code: "AUDIO_TOO_LARGE",
      message: "Audio uploads must be 500 MB or smaller."
    });
  });
});

function listen(app: ReturnType<typeof createApp>): Promise<Server> {
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, () => resolve(server));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function fakeTranscriptionClient() {
  return {
    health: vi.fn(),
    transcribe: vi.fn()
  };
}
