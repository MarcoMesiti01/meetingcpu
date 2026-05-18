import { mkdir, writeFile } from "node:fs/promises";
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
  const id = sessionSlugFromDate(input.now ?? new Date(), input.title ?? "local meeting");
  const path = join(input.dataRoot, "sessions", id);
  await mkdir(path, { recursive: true });
  return { id, path };
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
  await writeFile(join(session.path, "metadata.json"), JSON.stringify(metadata, null, 2));
}
