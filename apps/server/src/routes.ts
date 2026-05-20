import { mkdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import multer from "multer";
import { ChunkQueue, type ChunkQueueInput } from "./chunkQueue.js";
import {
  createChunkSession,
  finalizeChunkSession,
  markChunkFailed,
  saveChunkFile,
  saveChunkResult,
  type ChunkDiarizationStatus,
  type ChunkSession,
  type ChunkTranscriptResult,
  type ChunkTranscriptSegment
} from "./chunkSessions.js";
import { DEFAULT_MODEL_ID, listModelOptions, parseModelId, type ModelId } from "./models.js";
import { SessionEventHub } from "./sessionEvents.js";
import {
  createSession,
  saveFailedTranscription,
  saveRecording,
  saveTranscript,
  type Session,
  type SourceType,
  type TranscriptResult
} from "./sessions.js";

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface TranscriptionResult extends Omit<TranscriptResult, "segments"> {
  segments: TranscriptionSegment[];
  diarization?: ChunkDiarizationStatus;
}

export interface TranscriptionClient {
  health(): Promise<{ ok: boolean; service: string }>;
  transcribe(input: {
    audioPath: string;
    modelId: ModelId;
    language: string | null;
    diarization?: boolean;
  }): Promise<TranscriptionResult>;
}

export interface RouteChunkQueueInput extends ChunkQueueInput {
  session: ChunkSession;
  chunkPath: string;
  modelId: ModelId;
  language: string | null;
  diarization: boolean;
}

export interface RouteChunkSessionState {
  session: ChunkSession;
  modelId: ModelId;
  language: string | null;
  diarization: boolean;
}

export interface RouteDependencies {
  dataRoot: string;
  transcriptionClient: TranscriptionClient;
  maxAudioUploadBytes?: number;
  events?: SessionEventHub;
  chunkQueue?: ChunkQueue<RouteChunkQueueInput>;
  chunkSessionStore?: Map<string, RouteChunkSessionState>;
}

const MAX_AUDIO_UPLOAD_BYTES = 500 * 1024 * 1024;
const UPLOAD_CHUNKING_UNAVAILABLE = {
  code: "UPLOAD_CHUNKING_UNAVAILABLE",
  message: "Upload chunking requires ffmpeg. Install ffmpeg or set FFMPEG_PATH."
};

export function createRoutes(dependencies: RouteDependencies): Router {
  const router = Router();
  const maxAudioUploadBytes = dependencies.maxAudioUploadBytes ?? MAX_AUDIO_UPLOAD_BYTES;
  const events = dependencies.events ?? new SessionEventHub();
  const chunkSessionStore = dependencies.chunkSessionStore ?? new Map<string, RouteChunkSessionState>();
  const chunkQueue =
    dependencies.chunkQueue ??
    new ChunkQueue<RouteChunkQueueInput>({
      events,
      processChunk: async (input) => {
        try {
          const transcript = await dependencies.transcriptionClient.transcribe({
            audioPath: input.chunkPath,
            modelId: input.modelId,
            language: input.language,
            diarization: input.diarization
          });
          const result = toChunkTranscriptResult(input.chunkIndex, transcript);
          await saveChunkResult({ session: input.session, result });
          events.publish({
            type: "chunk-transcribed",
            sessionId: input.sessionId,
            chunkIndex: input.chunkIndex,
            text: result.text,
            diarization: result.diarization
          });
        } catch (error) {
          const failure = chunkErrorBody(error);
          await markChunkFailed({
            session: input.session,
            chunkIndex: input.chunkIndex,
            code: failure.code,
            message: failure.message
          });
          throw createChunkProcessingError(failure);
        }
      }
    });
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_request, _file, callback) => {
        const uploadPath = join(dependencies.dataRoot, "uploads", "tmp");
        void mkdir(uploadPath, { recursive: true })
          .then(() => callback(null, uploadPath))
          .catch((error: unknown) => callback(error as Error, uploadPath));
      },
      filename: (_request, file, callback) => {
        callback(null, `${randomUUID()}${extname(file.originalname) || ".tmp"}`);
      }
    }),
    limits: { fileSize: maxAudioUploadBytes }
  });

  router.get("/health", async (_request, response) => {
    response.json({ ok: true });
  });

  router.get("/models", async (_request, response) => {
    response.json({
      defaultModelId: DEFAULT_MODEL_ID,
      models: listModelOptions()
    });
  });

  router.post("/sessions", asyncHandler(async (request, response) => {
    const modelResult = parseModelId(String(request.body.modelId ?? DEFAULT_MODEL_ID));
    if (!modelResult.ok) {
      response.status(400).json(modelResult.error);
      return;
    }

    const session = await createChunkSession({
      dataRoot: dependencies.dataRoot,
      title: String(request.body.title ?? "local meeting"),
      modelId: modelResult.value
    });
    const state: RouteChunkSessionState = {
      session,
      modelId: modelResult.value,
      language: request.body.language ? String(request.body.language) : null,
      diarization: parseBoolean(request.body.diarization)
    };
    chunkSessionStore.set(session.id, state);
    events.publish({
      type: "session-created",
      sessionId: session.id,
      sessionPath: session.path,
      inProgressTranscriptPath: session.inProgressTranscriptPath
    });

    response.status(201).json({
      sessionId: session.id,
      sessionPath: session.path,
      inProgressTranscriptPath: session.inProgressTranscriptPath
    });
  }));

  router.get("/sessions/:id/events", (request, response) => {
    const state = chunkSessionStore.get(request.params.id);
    if (!state) {
      response.status(404).json({ code: "SESSION_NOT_FOUND", message: "Session was not found." });
      return;
    }

    response.status(200);
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders?.();
    const unsubscribe = events.subscribe(state.session.id, response);
    request.on("close", unsubscribe);
  });

  router.post("/sessions/:id/chunks", upload.single("audio"), asyncHandler(async (request, response) => {
    const state = chunkSessionStore.get(request.params.id);
    if (!state) {
      await cleanupUploadedFile(request.file);
      response.status(404).json({ code: "SESSION_NOT_FOUND", message: "Session was not found." });
      return;
    }

    if (!request.file) {
      response.status(400).json({ code: "AUDIO_REQUIRED", message: "Attach an audio file using the 'audio' field." });
      return;
    }

    const chunkFields = parseChunkFields(request);
    if (!chunkFields.ok) {
      await cleanupUploadedFile(request.file);
      response.status(400).json(chunkFields.error);
      return;
    }

    const saved = await saveChunkFile({
      session: state.session,
      sourcePath: request.file.path,
      index: chunkFields.value.chunkIndex,
      startSeconds: chunkFields.value.startSeconds,
      endSeconds: chunkFields.value.endSeconds,
      overlapSeconds: chunkFields.value.overlapSeconds,
      mimeType: request.file.mimetype || String(request.body.mimeType ?? "audio/webm"),
      originalName: request.file.originalname
    });
    events.publish({ type: "chunk-saved", sessionId: state.session.id, chunkIndex: saved.index });
    void chunkQueue.enqueue({
      sessionId: state.session.id,
      chunkIndex: saved.index,
      session: state.session,
      chunkPath: saved.path,
      modelId: state.modelId,
      language: state.language,
      diarization: state.diarization
    });

    response.status(202).json({
      sessionId: state.session.id,
      chunkIndex: saved.index,
      status: "queued"
    });
  }));

  router.post("/sessions/:id/finalize", asyncHandler(async (request, response) => {
    const state = chunkSessionStore.get(request.params.id);
    if (!state) {
      response.status(404).json({ code: "SESSION_NOT_FOUND", message: "Session was not found." });
      return;
    }

    await chunkQueue.waitForSession(state.session.id);
    const finalized = await finalizeChunkSession({ session: state.session });
    events.publish({
      type: "session-finalized",
      sessionId: state.session.id,
      transcriptPath: finalized.transcriptPath,
      partial: finalized.partial
    });

    response.json({
      sessionId: state.session.id,
      transcriptPath: finalized.transcriptPath,
      transcriptJsonPath: finalized.transcriptJsonPath,
      partial: finalized.partial
    });
  }));

  router.post("/transcriptions", upload.single("audio"), asyncHandler(async (request, response) => {
    const modelResult = parseModelId(String(request.body.modelId ?? ""));
    if (!modelResult.ok) {
      await cleanupUploadedFile(request.file);
      response.status(400).json(modelResult.error);
      return;
    }

    if (!request.file) {
      response.status(400).json({ code: "AUDIO_REQUIRED", message: "Attach an audio file using the 'audio' field." });
      return;
    }

    const sourceType = parseSourceType(request.body.sourceType);
    if (sourceType === "upload") {
      await cleanupUploadedFile(request.file);
      response.status(501).json(UPLOAD_CHUNKING_UNAVAILABLE);
      return;
    }

    let session: Session | null = null;
    let recordingPath: string | null = null;

    try {
      session = await createSession({
        dataRoot: dependencies.dataRoot,
        title: String(request.body.title ?? "local meeting")
      });
      const saved = await saveRecording({
        session,
        originalName: request.file.originalname,
        sourcePath: request.file.path,
        sourceType,
        modelId: modelResult.value
      });
      recordingPath = saved.recordingPath;
      const transcript = await dependencies.transcriptionClient.transcribe({
        audioPath: saved.recordingPath,
        modelId: modelResult.value,
        language: request.body.language ? String(request.body.language) : null
      });
      await saveTranscript({ session, transcript, modelId: modelResult.value });

      response.status(201).json({
        sessionId: session.id,
        sessionPath: session.path,
        recordingPath: saved.recordingPath,
        transcript
      });
    } catch (error) {
      if (session && recordingPath) {
        await saveFailedTranscription({
          session,
          modelId: modelResult.value,
          error: transcriptionErrorBody(error)
        });
      }
      await cleanupUploadedFile(request.file);
      respondWithTranscriptionError(response, error, { session, recordingPath });
    }
  }));

  return router;
}

function toChunkTranscriptResult(chunkIndex: number, transcript: TranscriptionResult): ChunkTranscriptResult {
  return {
    chunkIndex,
    text: transcript.text,
    language: transcript.language,
    durationSeconds: transcript.durationSeconds,
    segments: transcript.segments.map(toChunkTranscriptSegment),
    diarization: transcript.diarization ?? { available: false, enabled: false }
  };
}

function toChunkTranscriptSegment(segment: TranscriptionSegment): ChunkTranscriptSegment {
  return {
    start: segment.start,
    end: segment.end,
    text: segment.text,
    ...(segment.speaker ? { speaker: segment.speaker } : {})
  };
}

async function cleanupUploadedFile(file: Express.Multer.File | undefined): Promise<void> {
  if (!file?.path) {
    return;
  }

  try {
    await unlink(file.path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

function asyncHandler(handler: (request: Request, response: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (request, response, next) => {
    void handler(request, response, next).catch(next);
  };
}

function respondWithTranscriptionError(
  response: Response,
  error: unknown,
  context: { session: Session | null; recordingPath: string | null }
): void {
  const body = isStructuredTranscriptionError(error)
    ? { code: error.code, message: error.message }
    : { code: "TRANSCRIPTION_REQUEST_FAILED", message: "Transcription request failed." };
  const status = isStructuredTranscriptionError(error) ? statusFromError(error) : 500;

  response.status(status).json({
    ...body,
    ...(context.session ? { sessionId: context.session.id, sessionPath: context.session.path } : {}),
    ...(context.recordingPath ? { recordingPath: context.recordingPath } : {})
  });
}

function transcriptionErrorBody(error: unknown): { code: string; message: string } {
  if (isStructuredTranscriptionError(error)) {
    return { code: error.code, message: error.message };
  }

  return { code: "TRANSCRIPTION_REQUEST_FAILED", message: "Transcription request failed." };
}

function chunkErrorBody(error: unknown): { code: string; message: string } {
  if (isStructuredTranscriptionError(error)) {
    return { code: error.code, message: error.message };
  }

  return {
    code: "CHUNK_PROCESSING_FAILED",
    message: error instanceof Error ? error.message : "Chunk processing failed."
  };
}

function createChunkProcessingError(failure: { code: string; message: string }): Error & { code: string } {
  const error = new Error(failure.message) as Error & { code: string };
  error.code = failure.code;
  return error;
}

function statusFromError(error: unknown): number {
  if (!hasStatus(error)) {
    return 500;
  }

  if (error.status === 0) {
    return 503;
  }

  if (Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) {
    return error.status;
  }

  return 500;
}

function isStructuredTranscriptionError(error: unknown): error is { code: string; message: string; status: number } {
  return hasStatus(error) && hasStringProperty(error, "code") && hasStringProperty(error, "message");
}

function hasStatus(error: unknown): error is { status: number } {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number";
}

function hasStringProperty(error: object, property: "code" | "message"): error is Record<typeof property, string> {
  const record = error as Record<string, unknown>;
  return typeof record[property] === "string";
}

function parseSourceType(value: unknown): SourceType {
  return value === "upload" ? "upload" : "microphone";
}

function parseBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

function parseChunkFields(
  request: Request
):
  | {
      ok: true;
      value: { chunkIndex: number; startSeconds: number; endSeconds: number; overlapSeconds: number };
    }
  | { ok: false; error: { code: string; message: string } } {
  const chunkIndex = parseIntegerField(request.body.chunkIndex ?? request.body.index);
  const startSeconds = parseNumberField(request.body.startSeconds);
  const endSeconds = parseNumberField(request.body.endSeconds);
  const overlapSeconds = parseNumberField(request.body.overlapSeconds ?? 0);

  if (chunkIndex === null || startSeconds === null || endSeconds === null || overlapSeconds === null) {
    return {
      ok: false,
      error: {
        code: "INVALID_CHUNK_METADATA",
        message: "Chunk metadata must include numeric chunkIndex, startSeconds, endSeconds, and overlapSeconds."
      }
    };
  }

  return { ok: true, value: { chunkIndex, startSeconds, endSeconds, overlapSeconds } };
}

function parseIntegerField(value: unknown): number | null {
  const number = parseNumberField(value);
  return number !== null && Number.isInteger(number) ? number : null;
}

function parseNumberField(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function isNodeError(error: unknown): error is Error & { code?: string } {
  return error instanceof Error && "code" in error;
}
