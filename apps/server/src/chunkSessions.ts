import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import type { ModelId } from "./models.js";
import { createSession, type Session, type SourceType } from "./sessions.js";

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

export interface ChunkAcceptedTranscriptUpdate {
  acceptedSegments: ChunkTranscriptSegment[];
  acceptedText: string;
  transcriptSegments: ChunkTranscriptSegment[];
  transcriptText: string;
}

interface ChunkFailure {
  chunkIndex: number;
  code: string;
  message: string;
}

type ChunkStoredTranscriptResult = ChunkTranscriptResult & {
  acceptedSegments?: ChunkTranscriptSegment[];
};

const sessionMutationChains = new Map<string, Promise<void>>();

export async function createChunkSession(input: {
  dataRoot: string;
  now?: Date;
  title?: string;
  modelId: ModelId;
  sourceType?: SourceType;
}): Promise<ChunkSession> {
  const baseSession = await createSession({ dataRoot: input.dataRoot, now: input.now, title: input.title });
  const session = withChunkPaths(baseSession);
  try {
    await mkdir(session.chunksPath, { recursive: true });
    await mkdir(session.chunkResultsPath, { recursive: true });
    await writeManifest(session, []);
    await writeFile(session.inProgressTranscriptPath, "");
    await writeMetadata(session, {
      sessionId: session.id,
      sourceType: input.sourceType ?? "microphone",
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
  } catch (error) {
    await rm(session.path, { recursive: true, force: true });
    throw error;
  }
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
  return withSessionMutation(input.session, async () => {
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
    const manifest = upsertManifestEntry(await readManifest(input.session), entry);
    await writeManifest(input.session, manifest);
    await writeMetadata(input.session, {
      status: "chunk-recording",
      chunkCount: manifest.length,
      updatedAt: new Date().toISOString()
    });
    return entry;
  });
}

export async function saveChunkResult(input: {
  session: ChunkSession;
  result: ChunkTranscriptResult;
}): Promise<ChunkAcceptedTranscriptUpdate> {
  return withSessionMutation(input.session, async () => {
    await mkdir(input.session.chunkResultsPath, { recursive: true });
    const manifest = await readManifest(input.session);
    const manifestEntry = requireManifestEntry(manifest, input.result.chunkIndex);
    const storedResult: ChunkStoredTranscriptResult = {
      ...input.result,
      segments: normalizeSegments(input.result.segments, manifestEntry),
      acceptedSegments: []
    };
    const existingResults = (await readChunkResults(input.session)).filter(
      (result) => result.chunkIndex !== input.result.chunkIndex
    );
    const acceptedResults = applyAcceptedSegments([...existingResults, storedResult]);
    const acceptedTranscriptSegments = acceptedSegments(acceptedResults);
    const resultAcceptedSegments =
      acceptedResults.find((result) => result.chunkIndex === input.result.chunkIndex)?.acceptedSegments ?? [];

    await Promise.all(
      acceptedResults.map((result) => writeJsonAtomic(resultPath(input.session, result.chunkIndex), result))
    );
    await writeManifest(input.session, setManifestStatus(manifest, input.result.chunkIndex, "transcribed"));
    const formattedTranscriptText = transcriptText(acceptedTranscriptSegments, true);
    await writeFile(input.session.inProgressTranscriptPath, formattedTranscriptText);

    const metadata = await readMetadata(input.session);
    const status = readFailures(metadata).length > 0 ? "chunk-transcribing-partial" : "chunk-transcribing";
    await writeMetadata(input.session, {
      status,
      lastCommittedEndSeconds: maxSegmentEnd(acceptedTranscriptSegments),
      updatedAt: new Date().toISOString()
    });

    return {
      acceptedSegments: resultAcceptedSegments,
      acceptedText: transcriptText(resultAcceptedSegments, true),
      transcriptSegments: acceptedTranscriptSegments,
      transcriptText: formattedTranscriptText
    };
  });
}

export async function markChunkFailed(input: {
  session: ChunkSession;
  chunkIndex: number;
  code: string;
  message: string;
}): Promise<void> {
  await withSessionMutation(input.session, async () => {
    const manifest = await readManifest(input.session);
    requireManifestEntry(manifest, input.chunkIndex);
    await writeManifest(input.session, setManifestStatus(manifest, input.chunkIndex, "failed"));
    const metadata = await readMetadata(input.session);
    const failures = readFailures(metadata).filter((failure) => failure.chunkIndex !== input.chunkIndex);
    failures.push({ chunkIndex: input.chunkIndex, code: input.code, message: input.message });
    failures.sort((left, right) => left.chunkIndex - right.chunkIndex);
    await writeMetadata(input.session, {
      status: "chunk-transcribing-partial",
      failedChunks: failures,
      updatedAt: new Date().toISOString()
    });
  });
}

export async function finalizeChunkSession(input: {
  session: ChunkSession;
}): Promise<{ transcriptPath: string; transcriptJsonPath: string; partial: boolean }> {
  return withSessionMutation(input.session, async () => {
    const results = applyAcceptedSegments(await readChunkResults(input.session));
    await Promise.all(
      results.map((result) => writeJsonAtomic(resultPath(input.session, result.chunkIndex), result))
    );
    const segments = acceptedSegments(results);
    const text = transcriptText(segments, false);
    const language = results.find((result) => result.language)?.language ?? "";
    const metadata = await readMetadata(input.session);
    const manifest = await readManifest(input.session);
    const durationSeconds = Math.max(maxSegmentEnd(segments), maxManifestEnd(manifest));
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
    await writeJsonAtomic(transcriptJsonPath, transcript);
    await writeMetadata(input.session, {
      status: partial ? "transcribed-partial" : "transcribed",
      language,
      durationSeconds,
      partial,
      updatedAt: new Date().toISOString()
    });
    return { transcriptPath, transcriptJsonPath, partial };
  });
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

function aggregateDiarization(results: ChunkStoredTranscriptResult[]): ChunkDiarizationStatus {
  const available = results.some((result) => result.diarization.available);
  const enabled = results.some((result) => result.diarization.enabled);
  const error = enabled ? undefined : results.find((result) => result.diarization.error)?.diarization.error;
  return error ? { available, enabled, error } : { available, enabled };
}

function resultPath(session: ChunkSession, chunkIndex: number): string {
  return join(session.chunkResultsPath, `${chunkStem(chunkIndex)}.json`);
}

function upsertManifestEntry(manifest: ChunkManifestEntry[], entry: ChunkManifestEntry): ChunkManifestEntry[] {
  const next = manifest.filter((existingEntry) => existingEntry.index !== entry.index);
  next.push(entry);
  return next;
}

function setManifestStatus(
  manifest: ChunkManifestEntry[],
  chunkIndex: number,
  status: ChunkManifestEntry["status"]
): ChunkManifestEntry[] {
  requireManifestEntry(manifest, chunkIndex);
  return manifest.map((entry) => (entry.index === chunkIndex ? { ...entry, status } : entry));
}

function requireManifestEntry(manifest: ChunkManifestEntry[], chunkIndex: number): ChunkManifestEntry {
  const entry = manifest.find((manifestEntry) => manifestEntry.index === chunkIndex);
  if (!entry) {
    throw new Error(`Missing manifest entry for chunk ${chunkIndex}`);
  }
  return entry;
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
  await writeJsonAtomic(session.manifestPath, sorted);
}

async function readChunkResults(session: ChunkSession): Promise<ChunkStoredTranscriptResult[]> {
  const fileNames = await readdir(session.chunkResultsPath);
  const results = await Promise.all(
    fileNames
      .filter((fileName) => /^chunk-\d{6}\.json$/.test(fileName))
      .map(async (fileName) => {
        return JSON.parse(await readFile(join(session.chunkResultsPath, fileName), "utf8")) as ChunkStoredTranscriptResult;
      })
  );
  return results.sort((left, right) => left.chunkIndex - right.chunkIndex);
}

function normalizeSegments(
  segments: ChunkTranscriptSegment[],
  manifestEntry: ChunkManifestEntry
): ChunkTranscriptSegment[] {
  return segments
    .map((segment) => {
      if (segment.start >= manifestEntry.startSeconds || segment.end > manifestEntry.endSeconds) {
        return segment;
      }
      return {
        ...segment,
        start: segment.start + manifestEntry.startSeconds,
        end: segment.end + manifestEntry.startSeconds
      };
    })
    .sort(compareSegments);
}

function applyAcceptedSegments(results: ChunkStoredTranscriptResult[]): ChunkStoredTranscriptResult[] {
  let lastAcceptedEnd = 0;
  return [...results]
    .sort((left, right) => left.chunkIndex - right.chunkIndex)
    .map((result) => {
      const resultAcceptedSegments: ChunkTranscriptSegment[] = [];
      for (const segment of [...result.segments].sort(compareSegments)) {
        if (segment.end > lastAcceptedEnd) {
          resultAcceptedSegments.push(segment);
          lastAcceptedEnd = Math.max(lastAcceptedEnd, segment.end);
        }
      }
      return { ...result, acceptedSegments: resultAcceptedSegments };
    });
}

function acceptedSegments(results: ChunkStoredTranscriptResult[]): ChunkTranscriptSegment[] {
  return results.flatMap((result) => result.acceptedSegments ?? []).sort(compareSegments);
}

function compareSegments(left: ChunkTranscriptSegment, right: ChunkTranscriptSegment): number {
  return left.start - right.start || left.end - right.end;
}

function transcriptText(segments: ChunkTranscriptSegment[], withTimestamps: boolean): string {
  if (withTimestamps) {
    return segments.map(formatTranscriptLine).join("");
  }
  return segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join("\n");
}

function maxSegmentEnd(segments: ChunkTranscriptSegment[]): number {
  return segments.reduce((maxEnd, segment) => Math.max(maxEnd, segment.end), 0);
}

function maxManifestEnd(manifest: ChunkManifestEntry[]): number {
  return manifest.reduce((maxEnd, entry) => Math.max(maxEnd, entry.endSeconds), 0);
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
  await writeJsonAtomic(join(session.path, "metadata.json"), { ...existing, ...metadata });
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

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporaryPath = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function withSessionMutation<T>(session: ChunkSession, operation: () => Promise<T>): Promise<T> {
  const key = session.path;
  const previous = sessionMutationChains.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  const tail = next.then(
    () => undefined,
    () => undefined
  );
  sessionMutationChains.set(key, tail);
  return next.finally(() => {
    if (sessionMutationChains.get(key) === tail) {
      sessionMutationChains.delete(key);
    }
  });
}

function isNodeError(error: unknown): error is Error & { code?: string } {
  return error instanceof Error && "code" in error;
}
