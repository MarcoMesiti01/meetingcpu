import { access, mkdir, mkdtemp, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { saveChunkFile as realSaveChunkFile } from "./chunkSessions.js";
import type { RouteChunkSessionState } from "./routes.js";
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

  it("rejects late chunks while a session is finalizing", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    let resolveWait!: () => void;
    const chunkQueue = {
      enqueue: vi.fn().mockResolvedValue(undefined),
      waitForSession: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveWait = resolve;
          })
      )
    };
    const app = createApp({
      dataRoot,
      transcriptionClient: fakeTranscriptionClient(),
      chunkQueue
    });
    const created = await request(app).post("/api/sessions").send({ title: "Finalizing", modelId: "small" }).expect(201);

    const finalizeResponse = request(app)
      .post(`/api/sessions/${created.body.sessionId}/finalize`)
      .expect(200)
      .then((response) => response);
    await vi.waitFor(() => expect(chunkQueue.waitForSession).toHaveBeenCalledWith(created.body.sessionId));

    const lateChunk = await request(app)
      .post(`/api/sessions/${created.body.sessionId}/chunks`)
      .field("chunkIndex", "1")
      .field("startSeconds", "0")
      .field("endSeconds", "2")
      .field("overlapSeconds", "0")
      .attach("audio", Buffer.from("late-chunk"), "late.webm")
      .expect(409);

    expect(lateChunk.body).toEqual({
      code: "SESSION_FINALIZING",
      message: "Session is finalizing and no longer accepts chunks."
    });
    expect(chunkQueue.enqueue).not.toHaveBeenCalled();
    await expect(readdir(join(dataRoot, "uploads", "tmp"))).resolves.toEqual([]);

    resolveWait();
    await finalizeResponse;
  });

  it("returns terminal JSON for chunks and events after a session is finalized", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const events = new SessionEventHub();
    const published: string[] = [];
    const app = createApp({
      dataRoot,
      transcriptionClient: fakeTranscriptionClient(),
      events
    });
    const created = await request(app).post("/api/sessions").send({ title: "Closed", modelId: "small" }).expect(201);
    events.subscribe(created.body.sessionId, (event) => published.push(event.type));

    await request(app).post(`/api/sessions/${created.body.sessionId}/finalize`).expect(200);

    const lateChunk = await request(app)
      .post(`/api/sessions/${created.body.sessionId}/chunks`)
      .field("chunkIndex", "1")
      .field("startSeconds", "0")
      .field("endSeconds", "2")
      .field("overlapSeconds", "0")
      .attach("audio", Buffer.from("late-chunk"), "late.webm")
      .expect(404);
    const lateEvents = await request(app).get(`/api/sessions/${created.body.sessionId}/events`).expect(404);

    expect(lateChunk.body.code).toBe("SESSION_NOT_FOUND");
    expect(lateEvents.body.code).toBe("SESSION_NOT_FOUND");
    expect(lateEvents.headers["content-type"]).not.toContain("text/event-stream");
    expect(published).toContain("session-finalized");
    await expect(readdir(join(dataRoot, "uploads", "tmp"))).resolves.toEqual([]);
  });

  it("rejects invalid chunk metadata before saving work", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const chunkQueue = {
      enqueue: vi.fn().mockResolvedValue(undefined),
      waitForSession: vi.fn().mockResolvedValue(undefined)
    };
    const app = createApp({
      dataRoot,
      transcriptionClient: fakeTranscriptionClient(),
      chunkQueue
    });
    const created = await request(app).post("/api/sessions").send({ title: "Metadata", modelId: "small" }).expect(201);

    const invalidMetadata = [
      { chunkIndex: "0", startSeconds: "0", endSeconds: "2", overlapSeconds: "0" },
      { chunkIndex: "1.5", startSeconds: "0", endSeconds: "2", overlapSeconds: "0" },
      { chunkIndex: "1", startSeconds: "-1", endSeconds: "2", overlapSeconds: "0" },
      { chunkIndex: "1", startSeconds: "2", endSeconds: "2", overlapSeconds: "0" },
      { chunkIndex: "1", startSeconds: "0", endSeconds: "2", overlapSeconds: "2" }
    ];

    for (const metadata of invalidMetadata) {
      const response = await request(app)
        .post(`/api/sessions/${created.body.sessionId}/chunks`)
        .field("chunkIndex", metadata.chunkIndex)
        .field("startSeconds", metadata.startSeconds)
        .field("endSeconds", metadata.endSeconds)
        .field("overlapSeconds", metadata.overlapSeconds)
        .attach("audio", Buffer.from("invalid"), "invalid.webm")
        .expect(400);

      expect(response.body.code).toBe("INVALID_CHUNK_METADATA");
    }

    expect(chunkQueue.enqueue).not.toHaveBeenCalled();
    await expect(readdir(join(dataRoot, "sessions", created.body.sessionId, "chunks"))).resolves.toEqual([]);
    await expect(readdir(join(dataRoot, "uploads", "tmp"))).resolves.toEqual([]);
  });

  it("rejects duplicate chunk indexes before overwriting the manifest", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const chunkQueue = {
      enqueue: vi.fn().mockResolvedValue(undefined),
      waitForSession: vi.fn().mockResolvedValue(undefined)
    };
    const app = createApp({
      dataRoot,
      transcriptionClient: fakeTranscriptionClient(),
      chunkQueue
    });
    const created = await request(app).post("/api/sessions").send({ title: "Duplicates", modelId: "small" }).expect(201);

    await uploadChunk(app, created.body.sessionId, 1, "first").expect(202);
    const duplicate = await uploadChunk(app, created.body.sessionId, 1, "second").expect(409);

    expect(duplicate.body).toEqual({
      code: "DUPLICATE_CHUNK_INDEX",
      message: "Chunk index 1 has already been uploaded."
    });
    expect(chunkQueue.enqueue).toHaveBeenCalledTimes(1);
    await expect(readdir(join(dataRoot, "sessions", created.body.sessionId, "chunks"))).resolves.toEqual([
      "chunk-000001.webm"
    ]);
    await expect(readdir(join(dataRoot, "uploads", "tmp"))).resolves.toEqual([]);
  });

  it("rejects overlapping duplicate chunk uploads before saving or enqueueing duplicate work", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const chunkSessionStore = new Map<string, RouteChunkSessionState>();
    let releaseSave!: () => void;
    let saveStarted!: () => void;
    const saveStartedPromise = new Promise<void>((resolve) => {
      saveStarted = resolve;
    });
    const chunkQueue = {
      enqueue: vi.fn().mockResolvedValue(undefined),
      waitForSession: vi.fn().mockResolvedValue(undefined)
    };
    const app = createApp({
      dataRoot,
      transcriptionClient: fakeTranscriptionClient(),
      chunkQueue,
      chunkSessionStore,
      saveChunkFile: vi.fn(async ({ session, sourcePath, index, startSeconds, endSeconds, overlapSeconds }) => {
        saveStarted();
        await new Promise<void>((resolve) => {
          releaseSave = resolve;
        });
        const chunkPath = join(session.path, "chunks", "chunk-000001.webm");
        const contents = await readFile(sourcePath);
        await writeFile(chunkPath, contents);
        await unlink(sourcePath);
        return {
          index,
          path: chunkPath,
          startSeconds,
          endSeconds,
          overlapSeconds
        };
      })
    });
    const created = await request(app).post("/api/sessions").send({ title: "Concurrent duplicates", modelId: "small" }).expect(201);

    const firstUpload = uploadChunk(app, created.body.sessionId, 1, "first")
      .expect(202)
      .then((response) => response);
    await saveStartedPromise;

    const duplicate = await uploadChunk(app, created.body.sessionId, 1, "second").expect(409);

    expect(duplicate.body).toEqual({
      code: "DUPLICATE_CHUNK_INDEX",
      message: "Chunk index 1 has already been uploaded."
    });
    expect(chunkQueue.enqueue).not.toHaveBeenCalled();
    await expect(readdir(join(dataRoot, "uploads", "tmp"))).resolves.toHaveLength(1);

    releaseSave();
    await firstUpload;

    const state = chunkSessionStore.get(created.body.sessionId);
    expect(chunkQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(state?.activeChunkUploads).toBe(0);
    expect(state?.reservedChunkIndexes.size).toBe(0);
    await expect(readdir(join(dataRoot, "uploads", "tmp"))).resolves.toEqual([]);
  });

  it("ends accepted chunk uploads when duplicate cleanup fails", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const chunkSessionStore = new Map<string, RouteChunkSessionState>();
    const chunkQueue = {
      enqueue: vi.fn().mockResolvedValue(undefined),
      waitForSession: vi.fn().mockResolvedValue(undefined)
    };
    const app = createApp({
      dataRoot,
      transcriptionClient: fakeTranscriptionClient(),
      chunkQueue,
      chunkSessionStore,
      cleanupUploadedFile: vi.fn(async () => {
        throw new Error("cleanup failed");
      })
    });
    const created = await request(app).post("/api/sessions").send({ title: "Duplicate cleanup", modelId: "small" }).expect(201);

    await uploadChunk(app, created.body.sessionId, 1, "first").expect(202);
    await uploadChunk(app, created.body.sessionId, 1, "second").expect(500);

    const state = chunkSessionStore.get(created.body.sessionId);
    expect(state?.activeChunkUploads).toBe(0);
    expect(state?.chunkUploadWaiters).toEqual([]);
    expect(state?.reservedChunkIndexes.size).toBe(0);
  });

  it("cleans temp uploads and ends accepted chunk uploads when duplicate detection fails", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const chunkSessionStore = new Map<string, RouteChunkSessionState>();
    const chunkQueue = {
      enqueue: vi.fn().mockResolvedValue(undefined),
      waitForSession: vi.fn().mockResolvedValue(undefined)
    };
    const app = createApp({
      dataRoot,
      transcriptionClient: fakeTranscriptionClient(),
      chunkQueue,
      chunkSessionStore
    });
    const created = await request(app).post("/api/sessions").send({ title: "Manifest failure", modelId: "small" }).expect(201);
    await writeFile(join(dataRoot, "sessions", created.body.sessionId, "recording.manifest.json"), "{not-json");

    await uploadChunk(app, created.body.sessionId, 1, "chunk-audio").expect(500);

    const state = chunkSessionStore.get(created.body.sessionId);
    expect(state?.activeChunkUploads).toBe(0);
    expect(state?.chunkUploadWaiters).toEqual([]);
    expect(state?.reservedChunkIndexes.size).toBe(0);
    await expect(readdir(join(dataRoot, "uploads", "tmp"))).resolves.toEqual([]);
  });

  it("returns a controlled error and cleans temp uploads when enqueue fails synchronously", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const chunkQueue = {
      enqueue: vi.fn(() => {
        throw new Error("queue is unavailable");
      }),
      waitForSession: vi.fn().mockResolvedValue(undefined)
    };
    const app = createApp({
      dataRoot,
      transcriptionClient: fakeTranscriptionClient(),
      chunkQueue
    });
    const created = await request(app).post("/api/sessions").send({ title: "Queue failure", modelId: "small" }).expect(201);

    const response = await uploadChunk(app, created.body.sessionId, 1, "chunk-audio").expect(500);

    expect(response.body).toEqual({
      code: "CHUNK_UPLOAD_FAILED",
      message: "Chunk could not be queued for transcription."
    });
    await expect(readdir(join(dataRoot, "uploads", "tmp"))).resolves.toEqual([]);
    const metadata = JSON.parse(await readFile(join(dataRoot, "sessions", created.body.sessionId, "metadata.json"), "utf8"));
    expect(metadata.failedChunks).toEqual([
      { chunkIndex: 1, code: "CHUNK_QUEUE_FAILED", message: "queue is unavailable" }
    ]);
  });

  it("records failed chunk metadata when enqueue rejects asynchronously", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const events = new SessionEventHub();
    const published: unknown[] = [];
    const chunkQueue = {
      enqueue: vi.fn().mockRejectedValue(new Error("worker stopped")),
      waitForSession: vi.fn().mockResolvedValue(undefined)
    };
    const app = createApp({
      dataRoot,
      transcriptionClient: fakeTranscriptionClient(),
      chunkQueue,
      events
    });
    const created = await request(app).post("/api/sessions").send({ title: "Async queue failure", modelId: "small" }).expect(201);
    events.subscribe(created.body.sessionId, (event) => published.push(event));

    await uploadChunk(app, created.body.sessionId, 1, "chunk-audio").expect(202);

    await vi.waitFor(async () => {
      const metadata = JSON.parse(await readFile(join(dataRoot, "sessions", created.body.sessionId, "metadata.json"), "utf8"));
      expect(metadata.failedChunks).toEqual([
        { chunkIndex: 1, code: "CHUNK_QUEUE_FAILED", message: "worker stopped" }
      ]);
    });
    expect(published).toContainEqual(
      expect.objectContaining({
        type: "chunk-failed",
        sessionId: created.body.sessionId,
        chunkIndex: 1,
        code: "CHUNK_QUEUE_FAILED",
        message: "worker stopped"
      })
    );
  });

  it("finalize waits for an accepted chunk upload to finish enqueue registration", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const chunkSessionStore = new Map<string, RouteChunkSessionState>();
    let releaseSave!: () => void;
    let saveStarted!: () => void;
    const saveStartedPromise = new Promise<void>((resolve) => {
      saveStarted = resolve;
    });
    const chunkQueue = {
      enqueue: vi.fn().mockResolvedValue(undefined),
      waitForSession: vi.fn().mockResolvedValue(undefined)
    };
    const app = createApp({
      dataRoot,
      transcriptionClient: fakeTranscriptionClient(),
      chunkQueue,
      chunkSessionStore,
      saveChunkFile: vi.fn(async ({ session, sourcePath, index, startSeconds, endSeconds }) => {
        saveStarted();
        await new Promise<void>((resolve) => {
          releaseSave = resolve;
        });
        const chunkPath = join(session.path, "chunks", "chunk-000001.webm");
        await writeFile(chunkPath, await readFile(sourcePath));
        return {
          index,
          path: chunkPath,
          startSeconds,
          endSeconds,
          overlapSeconds: 0
        };
      })
    });
    const created = await request(app).post("/api/sessions").send({ title: "Lifecycle", modelId: "small" }).expect(201);

    const uploadResponse = uploadChunk(app, created.body.sessionId, 1, "chunk-audio")
      .expect(202)
      .then((response) => response);
    await saveStartedPromise;
    const finalizeResponse = request(app)
      .post(`/api/sessions/${created.body.sessionId}/finalize`)
      .expect(200)
      .then((response) => response);

    await vi.waitFor(() => {
      expect(chunkSessionStore.get(created.body.sessionId)?.status).toBe("finalizing");
    });
    expect(chunkQueue.waitForSession).not.toHaveBeenCalled();

    releaseSave();
    await uploadResponse;
    await finalizeResponse;

    expect(chunkQueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({ chunkIndex: 1 }));
    expect(chunkQueue.waitForSession).toHaveBeenCalledWith(created.body.sessionId);
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
      transcriptionClient,
      ffmpegChunks: {
        resolveFfmpegPath: vi.fn().mockResolvedValue(null)
      }
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
    await expect(readdir(join(dataRoot, "uploads", "tmp"))).resolves.toEqual([]);
    await expect(access(join(dataRoot, "sessions"))).rejects.toThrow();
  });

  it("chunks uploaded audio locally and finalizes it through the queue", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const transcribe = vi.fn(async ({ audioPath }: { audioPath: string }) => {
      const text = (await readFile(audioPath, "utf8")).trim();
      return {
        text,
        language: "en",
        durationSeconds: 1,
        segments: [{ start: 0, end: 1, text }],
        diarization: { available: true, enabled: true }
      };
    });
    const splitAudioIntoChunks = vi.fn(async ({ outputDirectory }: { outputDirectory: string }) => {
      await mkdir(outputDirectory, { recursive: true });
      const chunkPaths = [join(outputDirectory, "chunk-000000.webm"), join(outputDirectory, "chunk-000001.webm")];
      await writeFile(chunkPaths[0], "Hello");
      await writeFile(chunkPaths[1], "world");
      return [
        { index: 0, path: chunkPaths[0], startSeconds: 0, endSeconds: 30, durationSeconds: 30 },
        { index: 1, path: chunkPaths[1], startSeconds: 30, endSeconds: 60, durationSeconds: 30 }
      ];
    });
    const app = createApp({
      dataRoot,
      transcriptionClient: { health: vi.fn(), transcribe },
      ffmpegChunks: {
        resolveFfmpegPath: vi.fn().mockResolvedValue("C:\\bin\\ffmpeg.exe"),
        splitAudioIntoChunks
      }
    });

    const response = await request(app)
      .post("/api/transcriptions")
      .field("sourceType", "upload")
      .field("modelId", "small")
      .field("title", "Upload")
      .attach("audio", Buffer.from("upload-audio"), "meeting.webm")
      .expect(201);

    expect(splitAudioIntoChunks).toHaveBeenCalled();
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(response.body.sessionId).toContain("upload");
    expect(response.body.sessionPath).toBe(join(dataRoot, "sessions", response.body.sessionId));
    expect(response.body.recordingPath).toBe(join(response.body.sessionPath, "upload.webm"));
    expect(response.body.transcript.text).toBe("Hello\nworld");
    expect(response.body.transcriptPath).toBe(join(response.body.sessionPath, "transcript.txt"));
    expect(response.body.transcriptJsonPath).toBe(join(response.body.sessionPath, "transcript.json"));
    expect(response.body.partial).toBe(false);
    expect(splitAudioIntoChunks).toHaveBeenCalledWith(
      expect.objectContaining({
        inputPath: response.body.recordingPath
      })
    );
    await expect(readFile(response.body.recordingPath, "utf8")).resolves.toBe("upload-audio");
    await expect(readFile(response.body.transcriptPath, "utf8")).resolves.toBe("Hello\nworld\n");
    await expect(readFile(response.body.transcriptJsonPath, "utf8")).resolves.toContain('"text": "Hello\\nworld"');
    const metadata = JSON.parse(await readFile(join(response.body.sessionPath, "metadata.json"), "utf8"));
    expect(metadata).toMatchObject({
      sourceType: "upload",
      recordingPath: response.body.recordingPath,
      status: "transcribed"
    });
    await expect(readdir(join(dataRoot, "uploads", "tmp"))).resolves.toEqual([]);
  });

  it("preserves upload chunk metadata from the splitter for a shorter final chunk", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const transcribe = vi.fn(async ({ audioPath }: { audioPath: string }) => {
      const text = (await readFile(audioPath, "utf8")).trim();
      return {
        text,
        language: "en",
        durationSeconds: 1,
        segments: [{ start: 0, end: 1, text }],
        diarization: { available: false, enabled: false }
      };
    });
    const splitAudioIntoChunks = vi.fn(async ({ outputDirectory }: { outputDirectory: string }) => {
      await mkdir(outputDirectory, { recursive: true });
      const first = join(outputDirectory, "chunk-000000.webm");
      const final = join(outputDirectory, "chunk-000001.webm");
      await writeFile(first, "First chunk");
      await writeFile(final, "Final chunk");
      return [
        { index: 0, path: first, startSeconds: 0, endSeconds: 30, durationSeconds: 30 },
        { index: 1, path: final, startSeconds: 30, endSeconds: 35, durationSeconds: 5 }
      ];
    });
    const app = createApp({
      dataRoot,
      transcriptionClient: { health: vi.fn(), transcribe },
      ffmpegChunks: {
        resolveFfmpegPath: vi.fn().mockResolvedValue("C:\\bin\\ffmpeg.exe"),
        splitAudioIntoChunks
      }
    });

    const response = await request(app)
      .post("/api/transcriptions")
      .field("sourceType", "upload")
      .field("modelId", "small")
      .field("title", "Short final upload")
      .attach("audio", Buffer.from("upload-audio"), "meeting.webm")
      .expect(201);

    const manifest = JSON.parse(
      await readFile(join(dataRoot, "sessions", response.body.sessionId, "recording.manifest.json"), "utf8")
    );
    const manifestTiming = manifest.map(
      ({ index, startSeconds, endSeconds }: { index: number; startSeconds: number; endSeconds: number }) => ({
        index,
        startSeconds,
        endSeconds
      })
    );
    expect(manifestTiming).toEqual([
      { index: 1, startSeconds: 0, endSeconds: 30 },
      { index: 2, startSeconds: 30, endSeconds: 35 }
    ]);
    expect(response.body.transcript.durationSeconds).toBe(35);
    expect(response.body.transcript.chunks.map((chunk: { chunkIndex: number }) => chunk.chunkIndex)).toEqual([1, 2]);
    await expect(readFile(response.body.transcriptJsonPath, "utf8")).resolves.toContain('"durationSeconds": 35');
  });

  it("uses the injected chunk saver when chunking uploaded audio", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const transcribe = vi.fn(async ({ audioPath }: { audioPath: string }) => ({
      text: (await readFile(audioPath, "utf8")).trim(),
      language: "en",
      durationSeconds: 1,
      segments: [{ start: 0, end: 1, text: "Injected saver" }],
      diarization: { available: false, enabled: false }
    }));
    const splitAudioIntoChunks = vi.fn(async ({ outputDirectory }: { outputDirectory: string }) => {
      await mkdir(outputDirectory, { recursive: true });
      const chunkPath = join(outputDirectory, "chunk-000000.webm");
      await writeFile(chunkPath, "Injected saver");
      return [{ index: 0, path: chunkPath, startSeconds: 0, endSeconds: 30, durationSeconds: 30 }];
    });
    const saveChunkFile = vi.fn(
      async ({ session, sourcePath, index, startSeconds, endSeconds, overlapSeconds }: Parameters<NonNullable<Parameters<typeof createApp>[0]["saveChunkFile"]>>[0]) => {
        const chunkPath = join(session.path, "chunks", "chunk-000000.webm");
        await writeFile(chunkPath, await readFile(sourcePath));
        return { index, path: chunkPath, startSeconds, endSeconds, overlapSeconds };
      }
    );
    const app = createApp({
      dataRoot,
      transcriptionClient: { health: vi.fn(), transcribe },
      saveChunkFile,
      ffmpegChunks: {
        resolveFfmpegPath: vi.fn().mockResolvedValue("C:\\bin\\ffmpeg.exe"),
        splitAudioIntoChunks
      }
    });

    await request(app)
      .post("/api/transcriptions")
      .field("sourceType", "upload")
      .field("modelId", "small")
      .field("title", "Injected upload saver")
      .attach("audio", Buffer.from("upload-audio"), "meeting.webm")
      .expect(201);

    expect(saveChunkFile).toHaveBeenCalledWith(
      expect.objectContaining({
        index: 1,
        startSeconds: 0,
        endSeconds: 30
      })
    );
  });

  it("returns controlled JSON and records failure when upload chunk saving fails", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const splitAudioIntoChunks = vi.fn(async ({ outputDirectory }: { outputDirectory: string }) => {
      await mkdir(outputDirectory, { recursive: true });
      const chunkPath = join(outputDirectory, "chunk-000000.webm");
      await writeFile(chunkPath, "Unsaved chunk");
      return [{ index: 0, path: chunkPath, startSeconds: 0, endSeconds: 30, durationSeconds: 30 }];
    });
    const app = createApp({
      dataRoot,
      transcriptionClient: fakeTranscriptionClient(),
      saveChunkFile: vi.fn(async () => {
        throw new Error("chunk disk full");
      }),
      ffmpegChunks: {
        resolveFfmpegPath: vi.fn().mockResolvedValue("C:\\bin\\ffmpeg.exe"),
        splitAudioIntoChunks
      }
    });

    const response = await request(app)
      .post("/api/transcriptions")
      .field("sourceType", "upload")
      .field("modelId", "small")
      .field("title", "Save chunk failure")
      .attach("audio", Buffer.from("upload-audio"), "meeting.webm")
      .expect(500);

    expect(response.body).toMatchObject({
      code: "UPLOAD_CHUNK_SAVE_FAILED",
      message: "Uploaded audio could not be saved as transcription chunks."
    });
    await expect(readdir(join(dataRoot, "uploads", "tmp"))).resolves.toEqual([]);
    const metadata = JSON.parse(
      await readFile(join(dataRoot, "sessions", response.body.sessionId, "metadata.json"), "utf8")
    );
    expect(metadata).toMatchObject({
      status: "transcription-failed",
      error: {
        code: "UPLOAD_CHUNK_SAVE_FAILED",
        message: "Uploaded audio could not be saved as transcription chunks."
      }
    });
  });

  it("returns controlled JSON and records failure when the second uploaded chunk save fails", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const splitAudioIntoChunks = vi.fn(async ({ outputDirectory }: { outputDirectory: string }) => {
      await mkdir(outputDirectory, { recursive: true });
      const chunkPaths = [join(outputDirectory, "chunk-000000.webm"), join(outputDirectory, "chunk-000001.webm")];
      await writeFile(chunkPaths[0], "first");
      await writeFile(chunkPaths[1], "second");
      return [
        { index: 0, path: chunkPaths[0], startSeconds: 0, endSeconds: 30, durationSeconds: 30 },
        { index: 1, path: chunkPaths[1], startSeconds: 30, endSeconds: 60, durationSeconds: 30 }
      ];
    });
    const saveChunkFile = vi.fn(
      async (input: Parameters<NonNullable<Parameters<typeof createApp>[0]["saveChunkFile"]>>[0]) => {
        const { index } = input;
        if (index === 2) {
          throw new Error("chunk disk full");
        }
        return realSaveChunkFile(input);
      }
    );
    const app = createApp({
      dataRoot,
      transcriptionClient: {
        health: vi.fn(),
        transcribe: vi.fn(async ({ audioPath }: { audioPath: string }) => ({
          text: (await readFile(audioPath, "utf8")).trim(),
          language: "en",
          durationSeconds: 1,
          segments: [{ start: 0, end: 1, text: "first" }],
          diarization: { available: false, enabled: false }
        }))
      },
      saveChunkFile,
      ffmpegChunks: {
        resolveFfmpegPath: vi.fn().mockResolvedValue("C:\\bin\\ffmpeg.exe"),
        splitAudioIntoChunks
      }
    });

    const response = await request(app)
      .post("/api/transcriptions")
      .field("sourceType", "upload")
      .field("modelId", "small")
      .field("title", "Second save failure")
      .attach("audio", Buffer.from("upload-audio"), "meeting.webm")
      .expect(500);

    expect(saveChunkFile.mock.calls.map(([call]) => call.index)).toEqual([1, 2]);
    expect(response.body).toMatchObject({
      code: "UPLOAD_CHUNK_SAVE_FAILED",
      message: "Uploaded audio could not be saved as transcription chunks."
    });
    await expect(readdir(join(dataRoot, "uploads", "tmp"))).resolves.toEqual([]);
    const metadata = JSON.parse(
      await readFile(join(dataRoot, "sessions", response.body.sessionId, "metadata.json"), "utf8")
    );
    expect(metadata).toMatchObject({
      status: "transcription-failed",
      error: {
        code: "UPLOAD_CHUNK_SAVE_FAILED",
        message: "Uploaded audio could not be saved as transcription chunks."
      }
    });
  });

  it("returns a partial upload transcript when at least one chunk fails transcription", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const transcribe = vi
      .fn()
      .mockResolvedValueOnce({
        text: "Good upload chunk.",
        language: "en",
        durationSeconds: 2,
        segments: [{ start: 0, end: 2, text: "Good upload chunk." }],
        diarization: { available: false, enabled: false }
      })
      .mockRejectedValueOnce({ code: "MODEL_UNAVAILABLE", status: 503, message: "Model is unavailable." });
    const splitAudioIntoChunks = vi.fn(async ({ outputDirectory }: { outputDirectory: string }) => {
      await mkdir(outputDirectory, { recursive: true });
      const chunkPaths = [join(outputDirectory, "chunk-000000.webm"), join(outputDirectory, "chunk-000001.webm")];
      await writeFile(chunkPaths[0], "good");
      await writeFile(chunkPaths[1], "bad");
      return [
        { index: 0, path: chunkPaths[0], startSeconds: 0, endSeconds: 30, durationSeconds: 30 },
        { index: 1, path: chunkPaths[1], startSeconds: 30, endSeconds: 60, durationSeconds: 30 }
      ];
    });
    const app = createApp({
      dataRoot,
      transcriptionClient: { health: vi.fn(), transcribe },
      ffmpegChunks: {
        resolveFfmpegPath: vi.fn().mockResolvedValue("C:\\bin\\ffmpeg.exe"),
        splitAudioIntoChunks
      }
    });

    const response = await request(app)
      .post("/api/transcriptions")
      .field("sourceType", "upload")
      .field("modelId", "small")
      .field("title", "Partial upload")
      .attach("audio", Buffer.from("upload-audio"), "meeting.webm")
      .expect(201);

    expect(response.body.partial).toBe(true);
    expect(response.body.transcript.text).toBe("Good upload chunk.");
    const metadata = JSON.parse(await readFile(join(response.body.sessionPath, "metadata.json"), "utf8"));
    expect(metadata).toMatchObject({
      status: "transcribed-partial",
      partial: true,
      failedChunks: [{ chunkIndex: 2, code: "MODEL_UNAVAILABLE", message: "Model is unavailable." }]
    });
  });

  it("returns controlled JSON and records failure when upload transcript JSON cannot be read", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const transcribe = vi.fn(async ({ audioPath }: { audioPath: string }) => ({
      text: (await readFile(audioPath, "utf8")).trim(),
      language: "en",
      durationSeconds: 1,
      segments: [{ start: 0, end: 1, text: "Readable chunk" }],
      diarization: { available: false, enabled: false }
    }));
    const splitAudioIntoChunks = vi.fn(async ({ outputDirectory }: { outputDirectory: string }) => {
      await mkdir(outputDirectory, { recursive: true });
      const chunkPath = join(outputDirectory, "chunk-000000.webm");
      await writeFile(chunkPath, "Readable chunk");
      return [{ index: 0, path: chunkPath, startSeconds: 0, endSeconds: 30, durationSeconds: 30 }];
    });
    const app = createApp({
      dataRoot,
      transcriptionClient: { health: vi.fn(), transcribe },
      readUploadTranscriptJson: vi.fn(async () => {
        throw new Error("transcript json unavailable");
      }),
      ffmpegChunks: {
        resolveFfmpegPath: vi.fn().mockResolvedValue("C:\\bin\\ffmpeg.exe"),
        splitAudioIntoChunks
      }
    });

    const response = await request(app)
      .post("/api/transcriptions")
      .field("sourceType", "upload")
      .field("modelId", "small")
      .field("title", "Read failure")
      .attach("audio", Buffer.from("upload-audio"), "meeting.webm")
      .expect(500);

    expect(response.body).toMatchObject({
      code: "UPLOAD_TRANSCRIPT_READ_FAILED",
      message: "Uploaded audio was transcribed, but the transcript could not be read."
    });
    await expect(readdir(join(dataRoot, "uploads", "tmp"))).resolves.toEqual([]);
    const metadata = JSON.parse(
      await readFile(join(dataRoot, "sessions", response.body.sessionId, "metadata.json"), "utf8")
    );
    expect(metadata).toMatchObject({
      status: "transcription-failed",
      error: {
        code: "UPLOAD_TRANSCRIPT_READ_FAILED",
        message: "Uploaded audio was transcribed, but the transcript could not be read."
      }
    });
  });

  it("returns controlled JSON and cleans upload temp state when upload splitting fails", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const chunkSessionStore = new Map<string, RouteChunkSessionState>();
    const splitAudioIntoChunks = vi.fn(async ({ outputDirectory }: { outputDirectory: string }) => {
      await mkdir(outputDirectory, { recursive: true });
      await writeFile(join(outputDirectory, "chunk-000000.webm"), "partial");
      throw new Error("ffmpeg split failed");
    });
    const app = createApp({
      dataRoot,
      transcriptionClient: fakeTranscriptionClient(),
      chunkSessionStore,
      ffmpegChunks: {
        resolveFfmpegPath: vi.fn().mockResolvedValue("C:\\bin\\ffmpeg.exe"),
        splitAudioIntoChunks
      }
    });

    const response = await request(app)
      .post("/api/transcriptions")
      .field("sourceType", "upload")
      .field("modelId", "small")
      .field("title", "Split failure")
      .attach("audio", Buffer.from("upload-audio"), "meeting.webm")
      .expect(500);

    expect(response.body).toMatchObject({
      code: "UPLOAD_CHUNKING_FAILED",
      message: "Uploaded audio could not be split into transcription chunks."
    });
    expect(response.body.sessionId).toContain("split-failure");
    expect(chunkSessionStore.size).toBe(0);
    await expect(readdir(join(dataRoot, "uploads", "tmp"))).resolves.toEqual([]);
    const sessionPath = join(dataRoot, "sessions", response.body.sessionId);
    const metadata = JSON.parse(await readFile(join(sessionPath, "metadata.json"), "utf8"));
    expect(metadata).toMatchObject({
      status: "transcription-failed",
      error: {
        code: "UPLOAD_CHUNKING_FAILED",
        message: "Uploaded audio could not be split into transcription chunks."
      }
    });
    await expect(readdir(join(sessionPath, "chunks"))).resolves.toEqual([]);
  });

  it("returns controlled JSON and records failure when upload splitting produces no chunks", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const splitAudioIntoChunks = vi.fn(async ({ outputDirectory }: { outputDirectory: string }) => {
      await mkdir(outputDirectory, { recursive: true });
      return [];
    });
    const app = createApp({
      dataRoot,
      transcriptionClient: fakeTranscriptionClient(),
      ffmpegChunks: {
        resolveFfmpegPath: vi.fn().mockResolvedValue("C:\\bin\\ffmpeg.exe"),
        splitAudioIntoChunks
      }
    });

    const response = await request(app)
      .post("/api/transcriptions")
      .field("sourceType", "upload")
      .field("modelId", "small")
      .field("title", "Empty split")
      .attach("audio", Buffer.from("upload-audio"), "meeting.webm")
      .expect(500);

    expect(response.body).toMatchObject({
      code: "UPLOAD_CHUNKING_FAILED",
      message: "Uploaded audio could not be split into transcription chunks."
    });
    await expect(readdir(join(dataRoot, "uploads", "tmp"))).resolves.toEqual([]);
    const metadata = JSON.parse(
      await readFile(join(dataRoot, "sessions", response.body.sessionId, "metadata.json"), "utf8")
    );
    expect(metadata).toMatchObject({
      status: "transcription-failed",
      error: {
        code: "UPLOAD_CHUNKING_FAILED",
        message: "Uploaded audio could not be split into transcription chunks."
      }
    });
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

function uploadChunk(app: ReturnType<typeof createApp>, sessionId: string, chunkIndex: number, contents: string) {
  return request(app)
    .post(`/api/sessions/${sessionId}/chunks`)
    .field("chunkIndex", String(chunkIndex))
    .field("startSeconds", String((chunkIndex - 1) * 2))
    .field("endSeconds", String(chunkIndex * 2))
    .field("overlapSeconds", "0")
    .attach("audio", Buffer.from(contents), "chunk.webm");
}

function fakeTranscriptionClient() {
  return {
    health: vi.fn(),
    transcribe: vi.fn()
  };
}
