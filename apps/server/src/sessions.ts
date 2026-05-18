import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { ModelId } from "./models.js";

export type SourceType = "microphone" | "upload";

export interface Session {
  id: string;
  path: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptResult {
  text: string;
  language: string;
  durationSeconds: number;
  segments: TranscriptSegment[];
}

export function sessionSlugFromDate(now: Date, title: string): string {
  const stamp = now.toISOString().slice(0, 16).replace("T", "-").replace(":", "");
  const safeTitle = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${stamp}-${safeTitle || "local-meeting"}`;
}

export async function createSession(input: { dataRoot: string; now?: Date; title?: string }): Promise<Session> {
  const baseId = sessionSlugFromDate(input.now ?? new Date(), input.title ?? "local meeting");
  const sessionsPath = join(input.dataRoot, "sessions");
  await mkdir(sessionsPath, { recursive: true });

  for (let index = 1; ; index += 1) {
    const id = index === 1 ? baseId : `${baseId}-${index}`;
    const path = join(sessionsPath, id);
    try {
      await mkdir(path, { recursive: false });
      return { id, path };
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }
}

export async function saveRecording(input: {
  session: Session;
  originalName: string;
  buffer: Buffer;
  sourceType: SourceType;
  modelId: ModelId;
}): Promise<{ recordingPath: string }> {
  const extension = extname(input.originalName) || ".webm";
  const baseName = input.sourceType === "microphone" ? "recording" : "upload";
  const recordingPath = join(input.session.path, `${baseName}${extension}`);
  await writeFile(recordingPath, input.buffer);
  await writeMetadata(input.session, {
    sessionId: input.session.id,
    sourceType: input.sourceType,
    modelId: input.modelId,
    recordingPath,
    status: "recording-saved",
    updatedAt: new Date().toISOString()
  });
  return { recordingPath };
}

export async function saveTranscript(input: {
  session: Session;
  transcript: TranscriptResult;
  modelId: ModelId;
}): Promise<void> {
  await writeFile(join(input.session.path, "transcript.json"), JSON.stringify(input.transcript, null, 2));
  await writeFile(join(input.session.path, "transcript.txt"), `${input.transcript.text}\n`);
  await writeMetadata(input.session, {
    sessionId: input.session.id,
    modelId: input.modelId,
    status: "transcribed",
    language: input.transcript.language,
    durationSeconds: input.transcript.durationSeconds,
    updatedAt: new Date().toISOString()
  });
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

function isNodeError(error: unknown): error is Error & { code?: string } {
  return error instanceof Error && "code" in error;
}
