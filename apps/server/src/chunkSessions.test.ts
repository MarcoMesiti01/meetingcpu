import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createChunkSession,
  finalizeChunkSession,
  markChunkFailed,
  saveChunkFile,
  saveChunkResult
} from "./chunkSessions.js";

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function saveManifestedChunk(input: {
  root: string;
  session: Awaited<ReturnType<typeof createChunkSession>>;
  index: number;
  startSeconds: number;
  endSeconds: number;
  overlapSeconds?: number;
}): Promise<void> {
  const sourcePath = join(input.root, `chunk-${input.index}.webm`);
  await writeFile(sourcePath, `audio-${input.index}`);
  await saveChunkFile({
    session: input.session,
    sourcePath,
    index: input.index,
    startSeconds: input.startSeconds,
    endSeconds: input.endSeconds,
    overlapSeconds: input.overlapSeconds ?? 0,
    mimeType: "audio/webm"
  });
}

describe("chunk session storage", () => {
  it("creates chunk folders, manifest, in-progress transcript, and metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "meetingcpu-chunks-"));

    const session = await createChunkSession({
      dataRoot: root,
      now: new Date("2026-05-18T13:30:00.000Z"),
      title: "Live Sync",
      modelId: "small"
    });

    expect(session.id).toBe("2026-05-18-1330-live-sync");
    expect((await stat(session.chunksPath)).isDirectory()).toBe(true);
    expect((await stat(session.chunkResultsPath)).isDirectory()).toBe(true);
    await expect(readFile(session.manifestPath, "utf8")).resolves.toBe("[]\n");
    await expect(readFile(session.inProgressTranscriptPath, "utf8")).resolves.toBe("");

    const metadata = await readJson(join(session.path, "metadata.json"));
    expect(metadata).toMatchObject({
      sessionId: session.id,
      modelId: "small",
      sourceType: "microphone",
      status: "chunk-session-created",
      chunksPath: session.chunksPath,
      chunkResultsPath: session.chunkResultsPath,
      manifestPath: session.manifestPath,
      inProgressTranscriptPath: session.inProgressTranscriptPath,
      lastCommittedEndSeconds: 0
    });
    expect(typeof metadata.updatedAt).toBe("string");
  });

  it("defaults chunk sessions to microphone source type and can create upload sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "meetingcpu-chunks-"));

    const microphoneSession = await createChunkSession({ dataRoot: root, modelId: "small" });
    const uploadSession = await createChunkSession({ dataRoot: root, modelId: "small", sourceType: "upload" });

    await expect(readJson(join(microphoneSession.path, "metadata.json"))).resolves.toMatchObject({
      sourceType: "microphone"
    });
    await expect(readJson(join(uploadSession.path, "metadata.json"))).resolves.toMatchObject({
      sourceType: "upload"
    });
  });

  it("removes the session directory when setup fails after the session is created", async () => {
    const root = await mkdtemp(join(tmpdir(), "meetingcpu-chunks-"));
    const now = new Date("2026-05-18T13:30:00.000Z");
    const sessionPath = join(root, "sessions", "2026-05-18-1330-setup-failure");
    const setupError = new Error("cannot create in-progress transcript");
    vi.resetModules();
    vi.doMock("node:fs/promises", async () => {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...actual,
        writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
          if (args[0].toString().endsWith("transcript.in-progress.txt")) {
            throw setupError;
          }
          return await actual.writeFile(...args);
        }
      };
    });

    try {
      const { createChunkSession: createFailingChunkSession } = await import("./chunkSessions.js");
      await expect(
        createFailingChunkSession({
          dataRoot: root,
          now,
          title: "Setup Failure",
          modelId: "small"
        })
      ).rejects.toThrow(setupError);
      await expect(stat(sessionPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("saves a chunk file and records timing, mime type, and size in the manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "meetingcpu-chunks-"));
    const session = await createChunkSession({ dataRoot: root, modelId: "small" });
    const sourcePath = join(root, "browser-upload.tmp");
    await writeFile(sourcePath, "chunk-bytes");

    const entry = await saveChunkFile({
      session,
      sourcePath,
      index: 1,
      startSeconds: 4.5,
      endSeconds: 12,
      overlapSeconds: 1.5,
      mimeType: "audio/webm",
      originalName: "capture.webm"
    });

    expect(entry).toMatchObject({
      index: 1,
      fileName: "chunk-000001.webm",
      path: join(session.chunksPath, "chunk-000001.webm"),
      startSeconds: 4.5,
      endSeconds: 12,
      overlapSeconds: 1.5,
      mimeType: "audio/webm",
      byteSize: 11,
      status: "saved"
    });
    await expect(readFile(entry.path, "utf8")).resolves.toBe("chunk-bytes");

    const manifest = JSON.parse(await readFile(session.manifestPath, "utf8"));
    expect(manifest).toEqual([entry]);
  });

  it("uses webm extension for browser microphone chunks without an original name", async () => {
    const root = await mkdtemp(join(tmpdir(), "meetingcpu-chunks-"));
    const session = await createChunkSession({ dataRoot: root, modelId: "small" });
    const sourcePath = join(root, "browser-upload.tmp");
    await writeFile(sourcePath, "chunk-bytes");

    const entry = await saveChunkFile({
      session,
      sourcePath,
      index: 1,
      startSeconds: 0,
      endSeconds: 5,
      overlapSeconds: 0,
      mimeType: "audio/webm"
    });

    expect(entry.fileName).toBe("chunk-000001.webm");
    expect(entry.path).toBe(join(session.chunksPath, "chunk-000001.webm"));
    await expect(readFile(entry.path, "utf8")).resolves.toBe("chunk-bytes");
  });

  it("saves chunk results and appends de-duplicated transcript lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "meetingcpu-chunks-"));
    const session = await createChunkSession({ dataRoot: root, modelId: "small" });
    const sourcePath = join(root, "chunk.webm");
    await writeFile(sourcePath, "audio");
    await saveChunkFile({
      session,
      sourcePath,
      index: 1,
      startSeconds: 0,
      endSeconds: 15,
      overlapSeconds: 0,
      mimeType: "audio/webm"
    });
    await saveManifestedChunk({
      root,
      session,
      index: 2,
      startSeconds: 13,
      endSeconds: 21,
      overlapSeconds: 2
    });

    await saveChunkResult({
      session,
      result: {
        chunkIndex: 1,
        text: "Old overlap.\nHello there.\nNo speaker.",
        language: "en",
        durationSeconds: 10,
        diarization: { available: true, enabled: true },
        segments: [
          { start: 0, end: 4, text: "Old overlap.", speaker: "Speaker 1" },
          { start: 5, end: 8, text: "Hello there.", speaker: "Speaker 1" },
          { start: 12, end: 14, text: "No speaker." }
        ]
      }
    });

    await saveChunkResult({
      session,
      result: {
        chunkIndex: 2,
        text: "Duplicate overlap.\nNew line.",
        language: "en",
        durationSeconds: 8,
        diarization: { available: true, enabled: false, error: "No speakers detected." },
        segments: [
          { start: 13, end: 14, text: "Duplicate overlap.", speaker: "Speaker 2" },
          { start: 16, end: 18, text: "New line." }
        ]
      }
    });

    const resultPath = join(session.chunkResultsPath, "chunk-000001.json");
    const savedResult = JSON.parse(await readFile(resultPath, "utf8"));
    expect(savedResult.chunkIndex).toBe(1);
    expect(savedResult.acceptedSegments).toEqual([
      { start: 0, end: 4, text: "Old overlap.", speaker: "Speaker 1" },
      { start: 5, end: 8, text: "Hello there.", speaker: "Speaker 1" },
      { start: 12, end: 14, text: "No speaker." }
    ]);

    await expect(readFile(session.inProgressTranscriptPath, "utf8")).resolves.toBe(
      "[00:00:00] Speaker 1: Old overlap.\n" +
        "[00:00:05] Speaker 1: Hello there.\n" +
        "[00:00:12] No speaker.\n" +
        "[00:00:16] New line.\n"
    );

    const metadata = await readJson(join(session.path, "metadata.json"));
    expect(metadata).toMatchObject({
      status: "chunk-transcribing",
      lastCommittedEndSeconds: 18
    });
  });

  it("finalizes a chunk session from saved chunk results completed out of order", async () => {
    const root = await mkdtemp(join(tmpdir(), "meetingcpu-chunks-"));
    const session = await createChunkSession({ dataRoot: root, modelId: "small" });
    await saveManifestedChunk({ root, session, index: 1, startSeconds: 0, endSeconds: 4 });
    await saveManifestedChunk({ root, session, index: 2, startSeconds: 4, endSeconds: 8 });

    await saveChunkResult({
      session,
      result: {
        chunkIndex: 2,
        text: "Second chunk.",
        language: "en",
        durationSeconds: 4,
        diarization: { available: true, enabled: false, error: "No speakers detected." },
        segments: [{ start: 4, end: 8, text: "Second chunk." }]
      }
    });
    await saveChunkResult({
      session,
      result: {
        chunkIndex: 1,
        text: "First chunk.",
        language: "en",
        durationSeconds: 4,
        diarization: { available: false, enabled: false },
        segments: [{ start: 0, end: 4, text: "First chunk." }]
      }
    });

    await expect(readFile(session.inProgressTranscriptPath, "utf8")).resolves.toBe(
      "[00:00:00] First chunk.\n[00:00:04] Second chunk.\n"
    );

    const finalized = await finalizeChunkSession({ session });

    expect(finalized).toEqual({
      transcriptPath: join(session.path, "transcript.txt"),
      transcriptJsonPath: join(session.path, "transcript.json"),
      partial: false
    });
    await expect(readFile(finalized.transcriptPath, "utf8")).resolves.toBe("First chunk.\nSecond chunk.\n");

    const transcriptJson = JSON.parse(await readFile(finalized.transcriptJsonPath, "utf8"));
    expect(transcriptJson).toMatchObject({
      text: "First chunk.\nSecond chunk.",
      language: "en",
      durationSeconds: 8,
      diarization: { available: true, enabled: false, error: "No speakers detected." },
      partial: false
    });
    expect(transcriptJson.segments).toEqual([
      { start: 0, end: 4, text: "First chunk." },
      { start: 4, end: 8, text: "Second chunk." }
    ]);
  });

  it("normalizes chunk-relative timestamps before saving accepted segments", async () => {
    const root = await mkdtemp(join(tmpdir(), "meetingcpu-chunks-"));
    const session = await createChunkSession({ dataRoot: root, modelId: "small" });
    await saveManifestedChunk({
      root,
      session,
      index: 1,
      startSeconds: 20,
      endSeconds: 30,
      overlapSeconds: 2
    });

    await saveChunkResult({
      session,
      result: {
        chunkIndex: 1,
        text: "Chunk relative.",
        language: "en",
        durationSeconds: 10,
        diarization: { available: true, enabled: true },
        segments: [{ start: 1, end: 3, text: "Chunk relative.", speaker: "Speaker 1" }]
      }
    });

    const savedResult = JSON.parse(await readFile(join(session.chunkResultsPath, "chunk-000001.json"), "utf8"));
    expect(savedResult.segments).toEqual([{ start: 21, end: 23, text: "Chunk relative.", speaker: "Speaker 1" }]);
    expect(savedResult.acceptedSegments).toEqual([
      { start: 21, end: 23, text: "Chunk relative.", speaker: "Speaker 1" }
    ]);
    await expect(readFile(session.inProgressTranscriptPath, "utf8")).resolves.toBe(
      "[00:00:21] Speaker 1: Chunk relative.\n"
    );
  });

  it("finalizes transcript text and duration from accepted de-duplicated segments", async () => {
    const root = await mkdtemp(join(tmpdir(), "meetingcpu-chunks-"));
    const session = await createChunkSession({ dataRoot: root, modelId: "small" });
    await saveManifestedChunk({ root, session, index: 1, startSeconds: 0, endSeconds: 10 });
    await saveManifestedChunk({ root, session, index: 2, startSeconds: 8, endSeconds: 18, overlapSeconds: 2 });

    await saveChunkResult({
      session,
      result: {
        chunkIndex: 1,
        text: "Intro.\nShared overlap.",
        language: "en",
        durationSeconds: 10,
        diarization: { available: false, enabled: false },
        segments: [
          { start: 0, end: 6, text: "Intro." },
          { start: 7, end: 10, text: "Shared overlap." }
        ]
      }
    });
    await saveChunkResult({
      session,
      result: {
        chunkIndex: 2,
        text: "Shared overlap.\nFresh ending.",
        language: "en",
        durationSeconds: 10,
        diarization: { available: false, enabled: false },
        segments: [
          { start: 0, end: 2, text: "Shared overlap." },
          { start: 3, end: 8, text: "Fresh ending." }
        ]
      }
    });

    const finalized = await finalizeChunkSession({ session });

    await expect(readFile(finalized.transcriptPath, "utf8")).resolves.toBe("Intro.\nShared overlap.\nFresh ending.\n");
    const transcriptJson = JSON.parse(await readFile(finalized.transcriptJsonPath, "utf8"));
    expect(transcriptJson.text).toBe("Intro.\nShared overlap.\nFresh ending.");
    expect(transcriptJson.durationSeconds).toBe(18);
    expect(transcriptJson.segments).toEqual([
      { start: 0, end: 6, text: "Intro." },
      { start: 7, end: 10, text: "Shared overlap." },
      { start: 11, end: 16, text: "Fresh ending." }
    ]);
  });

  it("rejects chunk results and failures when the manifest entry is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "meetingcpu-chunks-"));
    const session = await createChunkSession({ dataRoot: root, modelId: "small" });

    await expect(
      saveChunkResult({
        session,
        result: {
          chunkIndex: 1,
          text: "Missing manifest.",
          language: "en",
          durationSeconds: 3,
          diarization: { available: false, enabled: false },
          segments: [{ start: 0, end: 3, text: "Missing manifest." }]
        }
      })
    ).rejects.toThrow("Missing manifest entry for chunk 1");

    await expect(
      markChunkFailed({
        session,
        chunkIndex: 1,
        code: "TRANSCRIBE_FAILED",
        message: "Unable to transcribe chunk."
      })
    ).rejects.toThrow("Missing manifest entry for chunk 1");
  });

  it("serializes concurrent chunk result saves without losing manifest or transcript updates", async () => {
    const root = await mkdtemp(join(tmpdir(), "meetingcpu-chunks-"));
    const session = await createChunkSession({ dataRoot: root, modelId: "small" });
    for (let index = 1; index <= 6; index += 1) {
      await saveManifestedChunk({ root, session, index, startSeconds: index - 1, endSeconds: index });
    }

    await Promise.all(
      Array.from({ length: 6 }, async (_, offset) => {
        const index = offset + 1;
        await saveChunkResult({
          session,
          result: {
            chunkIndex: index,
            text: `Line ${index}.`,
            language: "en",
            durationSeconds: 1,
            diarization: { available: false, enabled: false },
            segments: [{ start: 0, end: 1, text: `Line ${index}.` }]
          }
        });
      })
    );

    const manifest = JSON.parse(await readFile(session.manifestPath, "utf8"));
    expect(manifest.map((entry: { status: string }) => entry.status)).toEqual([
      "transcribed",
      "transcribed",
      "transcribed",
      "transcribed",
      "transcribed",
      "transcribed"
    ]);
    const metadata = await readJson(join(session.path, "metadata.json"));
    expect(metadata.lastCommittedEndSeconds).toBe(6);
    await expect(readFile(session.inProgressTranscriptPath, "utf8")).resolves.toBe(
      "[00:00:00] Line 1.\n" +
        "[00:00:01] Line 2.\n" +
        "[00:00:02] Line 3.\n" +
        "[00:00:03] Line 4.\n" +
        "[00:00:04] Line 5.\n" +
        "[00:00:05] Line 6.\n"
    );
  });

  it("marks failed chunks in metadata without deleting prior transcript text", async () => {
    const root = await mkdtemp(join(tmpdir(), "meetingcpu-chunks-"));
    const session = await createChunkSession({ dataRoot: root, modelId: "small" });
    const sourcePath = join(root, "chunk.webm");
    await writeFile(sourcePath, "audio");
    await saveChunkFile({
      session,
      sourcePath,
      index: 1,
      startSeconds: 0,
      endSeconds: 10,
      overlapSeconds: 0,
      mimeType: "audio/webm"
    });
    await saveManifestedChunk({ root, session, index: 2, startSeconds: 10, endSeconds: 20 });
    await saveChunkResult({
      session,
      result: {
        chunkIndex: 1,
        text: "Already saved.",
        language: "en",
        durationSeconds: 5,
        diarization: { available: false, enabled: false },
        segments: [{ start: 0, end: 5, text: "Already saved." }]
      }
    });

    await markChunkFailed({
      session,
      chunkIndex: 2,
      code: "TRANSCRIBE_FAILED",
      message: "Unable to transcribe chunk."
    });

    await expect(readFile(session.inProgressTranscriptPath, "utf8")).resolves.toBe("[00:00:00] Already saved.\n");
    const metadata = await readJson(join(session.path, "metadata.json"));
    expect(metadata).toMatchObject({
      status: "chunk-transcribing-partial",
      failedChunks: [
        {
          chunkIndex: 2,
          code: "TRANSCRIBE_FAILED",
          message: "Unable to transcribe chunk."
        }
      ],
      lastCommittedEndSeconds: 5
    });
  });
});
