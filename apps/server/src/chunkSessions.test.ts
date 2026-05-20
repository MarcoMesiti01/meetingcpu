import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

    await saveChunkResult({
      session,
      result: {
        chunkIndex: 1,
        text: "Old overlap.\nHello there.\nNo speaker.",
        language: "en",
        durationSeconds: 10,
        diarization: true,
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
        diarization: false,
        segments: [
          { start: 13, end: 14, text: "Duplicate overlap.", speaker: "Speaker 2" },
          { start: 16, end: 18, text: "New line." }
        ]
      }
    });

    const resultPath = join(session.chunkResultsPath, "chunk-000001.json");
    const savedResult = JSON.parse(await readFile(resultPath, "utf8"));
    expect(savedResult.chunkIndex).toBe(1);

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

  it("finalizes a chunk session from saved chunk results", async () => {
    const root = await mkdtemp(join(tmpdir(), "meetingcpu-chunks-"));
    const session = await createChunkSession({ dataRoot: root, modelId: "small" });

    await saveChunkResult({
      session,
      result: {
        chunkIndex: 2,
        text: "Second chunk.",
        language: "en",
        durationSeconds: 4,
        diarization: false,
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
        diarization: false,
        segments: [{ start: 0, end: 4, text: "First chunk." }]
      }
    });

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
      partial: false
    });
    expect(transcriptJson.segments).toEqual([
      { start: 0, end: 4, text: "First chunk." },
      { start: 4, end: 8, text: "Second chunk." }
    ]);
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
    await saveChunkResult({
      session,
      result: {
        chunkIndex: 1,
        text: "Already saved.",
        language: "en",
        durationSeconds: 5,
        diarization: false,
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
