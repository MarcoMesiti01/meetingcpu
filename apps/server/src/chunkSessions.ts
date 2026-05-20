import { appendFile, copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { ModelId } from "./models.js";
import { createSession, type Session } from "./sessions.js";

export interface ChunkSession extends Session {
  chunksPath: string;
  chunkResultsPath: string;
  manifestPath: string;
  inProgressTranscriptPath: string;
}

export interface ChunkManifestEntry {
  index: number;
  fileName: string;
  path: string;
  startSeconds: number;
  endSeconds: number;
  overlapSeconds: number;
  mimeType: string;
  byteSize: number;
  status: "saved" | "transcribed" | "failed";
}

export interface ChunkTranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface ChunkDiarizationStatus {
  available: boolean;
  enabled: boolean;
  error?: string;
}

export interface ChunkTranscriptResult {
  chunkIndex: number;
  text: string;
  language: string;
  durationSeconds: number;
  segments: ChunkTranscriptSegment[];
  diarization: ChunkDiarizationStatus;
}

interface ChunkFailure {
  chunkIndex: number;
  code: string;
  message: string;
}

export async function createChunkSession(input: {
  dataRoot: string;
  now?: Date;
  title?: string;
  modelId: ModelId;
}): Promise<ChunkSession> {
  const baseSession = await createSession({ dataRoot: input.dataRoot, now: input.now, title: input.title });
  const session = withChunkPaths(baseSession);
  await mkdir(session.chunksPath, { recursive: true });
  await mkdir(session.chunkResultsPath, { recursive: true });
  await writeFile(session.manifestPath, "[]\n");
  await writeFile(session.inProgressTranscriptPath, "");
  await writeMetadata(session, {
    sessionId: session.id,
    sourceType: "microphone",
    modelId: input.modelId,
    status: "chunk-session-created",
    chunksPath: session.chunksPath,
    chunkResultsPath: session.chunkResultsPath,
    manifestPath: session.manifestPath,
    inProgressTranscriptPath: session.inProgressTranscriptPath,
    lastCommittedEndSeconds: 0,
    updatedAt: new Date().toISOString()
  });
  return session;
}

export async function saveChunkFile(input: {
  session: ChunkSession;
  sourcePath: string;
  index: number;
  startSeconds: number;
  endSeconds: number;
  overlapSeconds: number;
  mimeType: string;
  originalName?: string;
}): Promise<ChunkManifestEntry> {
  await mkdir(input.session.chunksPath, { recursive: true });
  const fileName = `${chunkStem(input.index)}${chunkExtension(input.originalName, input.mimeType)}`;
  const destinationPath = join(input.session.chunksPath, fileName);
  await moveFile(input.sourcePath, destinationPath);
  const fileStat = await stat(destinationPath);
  const entry: ChunkManifestEntry = {
    index: input.index,
    fileName,
    path: destinationPath,
    startSeconds: input.startSeconds,
    endSeconds: input.endSeconds,
    overlapSeconds: input.overlapSeconds,
    mimeType: input.mimeType,
    byteSize: fileStat.size,
    status: "saved"
  };
  await upsertManifestEntry(input.session, entry);
  await writeMetadata(input.session, {
    status: "chunk-recording",
    chunkCount: (await readManifest(input.session)).length,
    updatedAt: new Date().toISOString()
  });
  return entry;
}

export async function saveChunkResult(input: { session: ChunkSession; result: ChunkTranscriptResult }): Promise<void> {
  await mkdir(input.session.chunkResultsPath, { recursive: true });
  await writeFile(resultPath(input.session, input.result.chunkIndex), JSON.stringify(input.result, null, 2));
  await updateManifestStatus(input.session, input.result.chunkIndex, "transcribed");

  const metadata = await readMetadata(input.session);
  const previousEnd = numberFromMetadata(metadata.lastCommittedEndSeconds);
  const keptSegments = input.result.segments.filter((segment) => segment.end > previousEnd);
  if (keptSegments.length > 0) {
    await appendFile(input.session.inProgressTranscriptPath, keptSegments.map(formatTranscriptLine).join(""));
  }

  const lastCommittedEndSeconds = keptSegments.reduce(
    (lastEnd, segment) => Math.max(lastEnd, segment.end),
    previousEnd
  );
  const status = readFailures(metadata).length > 0 ? "chunk-transcribing-partial" : "chunk-transcribing";
  await writeMetadata(input.session, {
    status,
    lastCommittedEndSeconds,
    updatedAt: new Date().toISOString()
  });
}

export async function markChunkFailed(input: {
  session: ChunkSession;
  chunkIndex: number;
  code: string;
  message: string;
}): Promise<void> {
  await updateManifestStatus(input.session, input.chunkIndex, "failed");
  const metadata = await readMetadata(input.session);
  const failures = readFailures(metadata).filter((failure) => failure.chunkIndex !== input.chunkIndex);
  failures.push({ chunkIndex: input.chunkIndex, code: input.code, message: input.message });
  failures.sort((left, right) => left.chunkIndex - right.chunkIndex);
  await writeMetadata(input.session, {
    status: "chunk-transcribing-partial",
    failedChunks: failures,
    updatedAt: new Date().toISOString()
  });
}

export async function finalizeChunkSession(input: {
  session: ChunkSession;
}): Promise<{ transcriptPath: string; transcriptJsonPath: string; partial: boolean }> {
  const results = await readChunkResults(input.session);
  const text = results.map((result) => result.text.trim()).filter(Boolean).join("\n");
  const segments = results.flatMap((result) => result.segments).sort((left, right) => left.start - right.start);
  const language = results.find((result) => result.language)?.language ?? "";
  const durationSeconds = results.reduce((total, result) => total + result.durationSeconds, 0);
  const metadata = await readMetadata(input.session);
  const manifest = await readManifest(input.session);
  const partial = readFailures(metadata).length > 0 || manifest.some((entry) => entry.status === "failed");
  const transcript = {
    text,
    language,
    durationSeconds,
    segments,
    diarization: aggregateDiarization(results),
    chunks: results,
    partial
  };
  const transcriptPath = join(input.session.path, "transcript.txt");
  const transcriptJsonPath = join(input.session.path, "transcript.json");
  await writeFile(transcriptPath, `${text}\n`);
  await writeFile(transcriptJsonPath, JSON.stringify(transcript, null, 2));
  await writeMetadata(input.session, {
    status: partial ? "transcribed-partial" : "transcribed",
    language,
    durationSeconds,
    partial,
    updatedAt: new Date().toISOString()
  });
  return { transcriptPath, transcriptJsonPath, partial };
}

function withChunkPaths(session: Session): ChunkSession {
  return {
    ...session,
    chunksPath: join(session.path, "chunks"),
    chunkResultsPath: join(session.path, "chunk-results"),
    manifestPath: join(session.path, "recording.manifest.json"),
    inProgressTranscriptPath: join(session.path, "transcript.in-progress.txt")
  };
}

function chunkStem(index: number): string {
  return `chunk-${index.toString().padStart(6, "0")}`;
}

function chunkExtension(originalName: string | undefined, mimeType: string): string {
  const extension = originalName ? extname(originalName) : "";
  if (extension) {
    return extension;
  }
  if (mimeType.includes("webm")) {
    return ".webm";
  }
  if (mimeType.includes("mp4")) {
    return ".mp4";
  }
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) {
    return ".mp3";
  }
  return ".webm";
}

function aggregateDiarization(results: ChunkTranscriptResult[]): ChunkDiarizationStatus {
  const available = results.some((result) => result.diarization.available);
  const enabled = results.some((result) => result.diarization.enabled);
  const error = enabled ? undefined : results.find((result) => result.diarization.error)?.diarization.error;
  return error ? { available, enabled, error } : { available, enabled };
}

function resultPath(session: ChunkSession, chunkIndex: number): string {
  return join(session.chunkResultsPath, `${chunkStem(chunkIndex)}.json`);
}

async function upsertManifestEntry(session: ChunkSession, entry: ChunkManifestEntry): Promise<void> {
  const manifest = await readManifest(session);
  const next = manifest.filter((existingEntry) => existingEntry.index !== entry.index);
  next.push(entry);
  await writeManifest(session, next);
}

async function updateManifestStatus(
  session: ChunkSession,
  chunkIndex: number,
  status: ChunkManifestEntry["status"]
): Promise<void> {
  const manifest = await readManifest(session);
  const next = manifest.map((entry) => (entry.index === chunkIndex ? { ...entry, status } : entry));
  if (next.length !== manifest.length || next.some((entry, index) => entry.status !== manifest[index]?.status)) {
    await writeManifest(session, next);
  }
}

async function readManifest(session: ChunkSession): Promise<ChunkManifestEntry[]> {
  try {
    return JSON.parse(await readFile(session.manifestPath, "utf8")) as ChunkManifestEntry[];
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeManifest(session: ChunkSession, manifest: ChunkManifestEntry[]): Promise<void> {
  const sorted = [...manifest].sort((left, right) => left.index - right.index);
  await writeFile(session.manifestPath, `${JSON.stringify(sorted, null, 2)}\n`);
}

async function readChunkResults(session: ChunkSession): Promise<ChunkTranscriptResult[]> {
  const fileNames = await readdir(session.chunkResultsPath);
  const results = await Promise.all(
    fileNames
      .filter((fileName) => /^chunk-\d{6}\.json$/.test(fileName))
      .map(async (fileName) => {
        return JSON.parse(await readFile(join(session.chunkResultsPath, fileName), "utf8")) as ChunkTranscriptResult;
      })
  );
  return results.sort((left, right) => left.chunkIndex - right.chunkIndex);
}

function formatTranscriptLine(segment: ChunkTranscriptSegment): string {
  const speaker = segment.speaker ? `${segment.speaker}: ` : "";
  return `[${formatTimestamp(segment.start)}] ${speaker}${segment.text}\n`;
}

function formatTimestamp(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  return [hours, minutes, remainingSeconds].map((part) => part.toString().padStart(2, "0")).join(":");
}

async function writeMetadata(session: Session, metadata: Record<string, unknown>): Promise<void> {
  const existing = await readMetadata(session);
  await writeFile(join(session.path, "metadata.json"), JSON.stringify({ ...existing, ...metadata }, null, 2));
}

async function readMetadata(session: Session): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(join(session.path, "metadata.json"), "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function numberFromMetadata(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function readFailures(metadata: Record<string, unknown>): ChunkFailure[] {
  if (!Array.isArray(metadata.failedChunks)) {
    return [];
  }
  return metadata.failedChunks.filter(isChunkFailure);
}

function isChunkFailure(value: unknown): value is ChunkFailure {
  if (!value || typeof value !== "object") {
    return false;
  }
  const failure = value as Record<string, unknown>;
  return (
    typeof failure.chunkIndex === "number" &&
    typeof failure.code === "string" &&
    typeof failure.message === "string"
  );
}

async function moveFile(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    await rename(sourcePath, destinationPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "EXDEV") {
      await copyFile(sourcePath, destinationPath);
      await unlink(sourcePath);
      return;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is Error & { code?: string } {
  return error instanceof Error && "code" in error;
}
