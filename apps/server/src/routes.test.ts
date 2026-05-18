import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";

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
});

function fakeTranscriptionClient() {
  return {
    health: vi.fn(),
    transcribe: vi.fn()
  };
}
