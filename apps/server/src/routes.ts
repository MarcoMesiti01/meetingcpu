import { mkdir, readFile, rm, unlink } from "node:fs/promises";
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
import { resolveFfmpegPath, splitAudioIntoChunks } from "./ffmpegChunks.js";
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
  status: "recording" | "finalizing" | "finalized";
  activeChunkUploads: number;
  chunkUploadWaiters: Array<() => void>;
  reservedChunkIndexes: Set<number>;
}

export interface RouteDependencies {
  dataRoot: string;
  transcriptionClient: TranscriptionClient;
  maxAudioUploadBytes?: number;
  events?: SessionEventHub;
  chunkQueue?: ChunkQueue<RouteChunkQueueInput>;
  chunkSessionStore?: Map<string, RouteChunkSessionState>;
  saveChunkFile?: typeof saveChunkFile;
  cleanupUploadedFile?: typeof cleanupUploadedFile;
  readUploadTranscriptJson?: typeof readUploadTranscriptJson;
  ffmpegChunks?: {
    resolveFfmpegPath?: typeof resolveFfmpegPath;
    splitAudioIntoChunks?: typeof splitAudioIntoChunks;
  };
}

const MAX_AUDIO_UPLOAD_BYTES = 500 * 1024 * 1024;
const UPLOAD_CHUNKING_UNAVAILABLE = {
  code: "UPLOAD_CHUNKING_UNAVAILABLE",
  message: "Upload chunking requires ffmpeg. Install ffmpeg or set FFMPEG_PATH."
};
const UPLOAD_CHUNKING_FAILED = {
  code: "UPLOAD_CHUNKING_FAILED",
  message: "Uploaded audio could not be split into transcription chunks."
};
const UPLOAD_CHUNK_SAVE_FAILED = {
  code: "UPLOAD_CHUNK_SAVE_FAILED",
  message: "Uploaded audio could not be saved as transcription chunks."
};
const UPLOAD_CHUNK_ENQUEUE_FAILED = {
  code: "UPLOAD_CHUNK_ENQUEUE_FAILED",
  message: "Uploaded audio chunks could not be queued for transcription."
};
const UPLOAD_CHUNK_PROCESSING_FAILED = {
  code: "UPLOAD_CHUNK_PROCESSING_FAILED",
  message: "Uploaded audio chunks could not finish transcription."
};
const UPLOAD_FINALIZE_FAILED = {
  code: "UPLOAD_FINALIZE_FAILED",
  message: "Uploaded audio chunks were processed, but the transcript could not be finalized."
};
const UPLOAD_TRANSCRIPT_READ_FAILED = {
  code: "UPLOAD_TRANSCRIPT_READ_FAILED",
  message: "Uploaded audio was transcribed, but the transcript could not be read."
};

export function createRoutes(dependencies: RouteDependencies): Router {
  const router = Router();
  const maxAudioUploadBytes = dependencies.maxAudioUploadBytes ?? MAX_AUDIO_UPLOAD_BYTES;
  const events = dependencies.events ?? new SessionEventHub();
  const chunkSessionStore = dependencies.chunkSessionStore ?? new Map<string, RouteChunkSessionState>();
  const saveUploadedChunk = dependencies.saveChunkFile ?? saveChunkFile;
  const cleanupUpload = dependencies.cleanupUploadedFile ?? cleanupUploadedFile;
  const readUploadTranscript = dependencies.readUploadTranscriptJson ?? readUploadTranscriptJson;
  const resolveUploadFfmpegPath = dependencies.ffmpegChunks?.resolveFfmpegPath ?? resolveFfmpegPath;
  const splitUploadAudio = dependencies.ffmpegChunks?.splitAudioIntoChunks ?? splitAudioIntoChunks;
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
          const acceptedUpdate = await saveChunkResult({ session: input.session, result });
          events.publish({
            type: "chunk-transcribed",
            sessionId: input.sessionId,
            chunkIndex: input.chunkIndex,
            text: acceptedUpdate.acceptedText,
            acceptedText: acceptedUpdate.acceptedText,
            acceptedSegments: acceptedUpdate.acceptedSegments,
            transcriptText: acceptedUpdate.transcriptText,
            transcriptSegments: acceptedUpdate.transcriptSegments,
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
      diarization: parseBoolean(request.body.diarization, true),
      status: "recording",
      activeChunkUploads: 0,
      chunkUploadWaiters: [],
      reservedChunkIndexes: new Set()
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
      await cleanupUpload(request.file);
      response.status(404).json({ code: "SESSION_NOT_FOUND", message: "Session was not found." });
      return;
    }

    if (state.status !== "recording") {
      await cleanupUpload(request.file);
      response.status(state.status === "finalized" ? 410 : 409).json(sessionClosedBody(state.status));
      return;
    }

    if (!request.file) {
      response.status(400).json({ code: "AUDIO_REQUIRED", message: "Attach an audio file using the 'audio' field." });
      return;
    }

    const chunkFields = parseChunkFields(request);
    if (!chunkFields.ok) {
      await cleanupUpload(request.file);
      response.status(400).json(chunkFields.error);
      return;
    }

    const acceptedUpload = beginChunkUpload(state, chunkFields.value.chunkIndex);
    if (!acceptedUpload.ok) {
      await cleanupUpload(request.file);
      response.status(acceptedUpload.statusCode).json(acceptedUpload.body);
      return;
    }

    let releaseAcceptedUpload = true;
    try {
      let isDuplicateChunk: boolean;
      try {
        isDuplicateChunk = await chunkIndexExists(state.session, chunkFields.value.chunkIndex);
      } catch (error) {
        await cleanupUpload(request.file);
        throw error;
      }

      if (isDuplicateChunk) {
        await cleanupUpload(request.file);
        response.status(409).json(duplicateChunkBody(chunkFields.value.chunkIndex));
        return;
      }

      let saved: Awaited<ReturnType<typeof saveChunkFile>>;
      try {
        saved = await saveUploadedChunk({
          session: state.session,
          sourcePath: request.file.path,
          index: chunkFields.value.chunkIndex,
          startSeconds: chunkFields.value.startSeconds,
          endSeconds: chunkFields.value.endSeconds,
          overlapSeconds: chunkFields.value.overlapSeconds,
          mimeType: request.file.mimetype || String(request.body.mimeType ?? "audio/webm"),
          originalName: request.file.originalname
        });
      } catch {
        await cleanupUpload(request.file);
        response.status(500).json({
          code: "CHUNK_UPLOAD_FAILED",
          message: "Chunk could not be saved for transcription."
        });
        return;
      }

      try {
        events.publish({ type: "chunk-saved", sessionId: state.session.id, chunkIndex: saved.index });
        const enqueuePromise = chunkQueue.enqueue({
          sessionId: state.session.id,
          chunkIndex: saved.index,
          session: state.session,
          chunkPath: saved.path,
          modelId: state.modelId,
          language: state.language,
          diarization: state.diarization
        });
        releaseAcceptedUpload = false;
        void trackChunkQueueCompletion({
          state,
          chunkIndex: saved.index,
          enqueuePromise,
          events
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Chunk queue failed.";
        await markChunkFailed({
          session: state.session,
          chunkIndex: saved.index,
          code: "CHUNK_QUEUE_FAILED",
          message
        });
        events.publish({
          type: "chunk-failed",
          sessionId: state.session.id,
          chunkIndex: saved.index,
          code: "CHUNK_QUEUE_FAILED",
          message
        });
        response.status(500).json({
          code: "CHUNK_UPLOAD_FAILED",
          message: "Chunk could not be queued for transcription."
        });
        return;
      }

      response.status(202).json({
        sessionId: state.session.id,
        chunkIndex: saved.index,
        status: "queued"
      });
    } finally {
      if (releaseAcceptedUpload) {
        endChunkUpload(state, chunkFields.value.chunkIndex);
      }
    }
  }));

  router.post("/sessions/:id/finalize", asyncHandler(async (request, response) => {
    const state = chunkSessionStore.get(request.params.id);
    if (!state) {
      response.status(404).json({ code: "SESSION_NOT_FOUND", message: "Session was not found." });
      return;
    }

    if (state.status !== "recording") {
      response.status(state.status === "finalized" ? 410 : 409).json(sessionClosedBody(state.status));
      return;
    }

    state.status = "finalizing";
    let finalized: Awaited<ReturnType<typeof finalizeChunkSession>>;
    try {
      await waitForChunkUploads(state);
      await chunkQueue.waitForSession(state.session.id);
      finalized = await finalizeChunkSession({ session: state.session });
    } catch (error) {
      state.status = "recording";
      throw error;
    }
    state.status = "finalized";
    events.publish({
      type: "session-finalized",
      sessionId: state.session.id,
      transcriptPath: finalized.transcriptPath,
      partial: finalized.partial
    });
    chunkSessionStore.delete(state.session.id);

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
      await handleUploadTranscription({
        request,
        response,
        dataRoot: dependencies.dataRoot,
        modelId: modelResult.value,
        title: String(request.body.title ?? "local meeting"),
        language: request.body.language ? String(request.body.language) : null,
        diarization: parseBoolean(request.body.diarization, true),
        cleanupUpload,
        resolveUploadFfmpegPath,
        splitUploadAudio,
        saveUploadedChunk,
        readUploadTranscript,
        chunkQueue,
        events
      });
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

interface UploadTranscriptionInput {
  request: Request;
  response: Response;
  dataRoot: string;
  modelId: ModelId;
  title: string;
  language: string | null;
  diarization: boolean;
  cleanupUpload: typeof cleanupUploadedFile;
  resolveUploadFfmpegPath: typeof resolveFfmpegPath;
  splitUploadAudio: typeof splitAudioIntoChunks;
  saveUploadedChunk: typeof saveChunkFile;
  readUploadTranscript: typeof readUploadTranscriptJson;
  chunkQueue: ChunkQueue<RouteChunkQueueInput>;
  events: SessionEventHub;
}

class UploadTranscriptionStageError extends Error {
  constructor(readonly failure: { code: string; message: string }) {
    super(failure.message);
  }
}

async function handleUploadTranscription(input: UploadTranscriptionInput): Promise<void> {
  let session: ChunkSession | null = null;
  let chunkOutputDirectory: string | null = null;
  try {
    const ffmpegPath = await input.resolveUploadFfmpegPath({ env: process.env });
    if (!ffmpegPath) {
      await input.cleanupUpload(input.request.file);
      input.response.status(501).json(UPLOAD_CHUNKING_UNAVAILABLE);
      return;
    }

    const activeSession = await createChunkSession({
      dataRoot: input.dataRoot,
      title: input.title,
      modelId: input.modelId,
      sourceType: "upload"
    });
    session = activeSession;
    const savedUpload = await saveRecording({
      session: activeSession,
      originalName: input.request.file!.originalname,
      sourcePath: input.request.file!.path,
      sourceType: "upload",
      modelId: input.modelId
    });
    input.events.publish({
      type: "session-created",
      sessionId: activeSession.id,
      sessionPath: activeSession.path,
      inProgressTranscriptPath: activeSession.inProgressTranscriptPath
    });

    const activeChunkOutputDirectory = join(input.dataRoot, "uploads", "tmp", activeSession.id);
    chunkOutputDirectory = activeChunkOutputDirectory;
    const chunkOutputPattern = join(
      activeChunkOutputDirectory,
      `chunk-%06d${extname(input.request.file?.originalname ?? "") || ".webm"}`
    );
    const chunks = await failUploadStageOnError(UPLOAD_CHUNKING_FAILED, () =>
      input.splitUploadAudio({
        ffmpegPath,
        inputPath: savedUpload.recordingPath,
        outputDirectory: activeChunkOutputDirectory,
        outputPattern: chunkOutputPattern,
        segmentSeconds: 30
      })
    );
    if (chunks.length === 0) {
      throw new UploadTranscriptionStageError(UPLOAD_CHUNKING_FAILED);
    }

    for (const chunk of chunks) {
      const uploadChunkIndex = chunk.index + 1;
      const saved = await failUploadStageOnError(UPLOAD_CHUNK_SAVE_FAILED, () =>
        input.saveUploadedChunk({
          session: activeSession,
          sourcePath: chunk.path,
          index: uploadChunkIndex,
          startSeconds: chunk.startSeconds,
          endSeconds: chunk.endSeconds,
          overlapSeconds: 0,
          mimeType: input.request.file?.mimetype || "audio/webm",
          originalName: input.request.file?.originalname
        })
      );
      input.events.publish({ type: "chunk-saved", sessionId: activeSession.id, chunkIndex: saved.index });
      await failUploadStageOnError(UPLOAD_CHUNK_ENQUEUE_FAILED, () =>
        input.chunkQueue.enqueue({
          sessionId: activeSession.id,
          chunkIndex: saved.index,
          session: activeSession,
          chunkPath: saved.path,
          modelId: input.modelId,
          language: input.language,
          diarization: input.diarization
        })
      );
    }

    await failUploadStageOnError(UPLOAD_CHUNK_PROCESSING_FAILED, async () => {
      await input.chunkQueue.waitForSession(activeSession.id);
      if (!(await hasSuccessfulUploadChunk(activeSession))) {
        throw new UploadTranscriptionStageError(UPLOAD_CHUNK_PROCESSING_FAILED);
      }
    });
    const finalized = await failUploadStageOnError(UPLOAD_FINALIZE_FAILED, () =>
      finalizeChunkSession({ session: activeSession })
    );
    const transcript = await failUploadStageOnError(UPLOAD_TRANSCRIPT_READ_FAILED, () =>
      input.readUploadTranscript(finalized.transcriptJsonPath)
    );

    await input.cleanupUpload(input.request.file).catch(() => undefined);
    await rm(activeChunkOutputDirectory, { recursive: true, force: true }).catch(() => undefined);

    input.events.publish({
      type: "session-finalized",
      sessionId: activeSession.id,
      transcriptPath: finalized.transcriptPath,
      partial: finalized.partial
    });

    input.response.status(201).json({
      sessionId: activeSession.id,
      sessionPath: activeSession.path,
      recordingPath: savedUpload.recordingPath,
      transcriptPath: finalized.transcriptPath,
      transcriptJsonPath: finalized.transcriptJsonPath,
      partial: finalized.partial,
      transcript
    });
  } catch (error) {
    await failUploadChunking({ upload: input, session, chunkOutputDirectory, failure: uploadFailureFromError(error) });
  }
}

async function readUploadTranscriptJson(transcriptJsonPath: string): Promise<unknown> {
  return JSON.parse(await readFile(transcriptJsonPath, "utf8"));
}

async function hasSuccessfulUploadChunk(session: ChunkSession): Promise<boolean> {
  const manifest = JSON.parse(await readFile(session.manifestPath, "utf8")) as unknown;
  return Array.isArray(manifest) && manifest.some((entry) => isChunkManifestStatus(entry, "transcribed"));
}

function isChunkManifestStatus(entry: unknown, status: string): boolean {
  return typeof entry === "object" && entry !== null && "status" in entry && entry.status === status;
}

async function failUploadStageOnError<T>(
  failure: { code: string; message: string },
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof UploadTranscriptionStageError) {
      throw error;
    }
    throw new UploadTranscriptionStageError(failure);
  }
}

function uploadFailureFromError(error: unknown): { code: string; message: string } {
  return error instanceof UploadTranscriptionStageError ? error.failure : UPLOAD_CHUNKING_FAILED;
}

async function failUploadChunking(input: {
  upload: Pick<UploadTranscriptionInput, "request" | "response" | "modelId" | "cleanupUpload">;
  session: ChunkSession | null;
  chunkOutputDirectory: string | null;
  failure: { code: string; message: string };
}): Promise<void> {
  await input.upload.cleanupUpload(input.upload.request.file).catch(() => undefined);
  if (input.chunkOutputDirectory) {
    await rm(input.chunkOutputDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
  if (input.session) {
    await saveFailedTranscription({
      session: input.session,
      modelId: input.upload.modelId,
      error: input.failure
    });
  }
  input.upload.response.status(500).json({
    ...input.failure,
    ...(input.session ? { sessionId: input.session.id, sessionPath: input.session.path } : {})
  });
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

function parseBoolean(value: unknown, defaultValue = false): boolean {
  if (value === undefined) {
    return defaultValue;
  }
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

  if (
    chunkIndex < 1 ||
    startSeconds < 0 ||
    endSeconds <= startSeconds ||
    overlapSeconds < 0 ||
    overlapSeconds >= endSeconds - startSeconds
  ) {
    return {
      ok: false,
      error: {
        code: "INVALID_CHUNK_METADATA",
        message:
          "Chunk metadata requires chunkIndex >= 1, startSeconds >= 0, endSeconds > startSeconds, and a non-negative overlapSeconds shorter than the chunk duration."
      }
    };
  }

  return { ok: true, value: { chunkIndex, startSeconds, endSeconds, overlapSeconds } };
}

async function chunkIndexExists(session: ChunkSession, chunkIndex: number): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(session.manifestPath, "utf8")) as Array<{ index?: unknown }>;
    return manifest.some((entry) => entry.index === chunkIndex);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function sessionClosedBody(status: "finalizing" | "finalized"): { code: string; message: string } {
  if (status === "finalizing") {
    return {
      code: "SESSION_FINALIZING",
      message: "Session is finalizing and no longer accepts chunks."
    };
  }

  return {
    code: "SESSION_FINALIZED",
    message: "Session has been finalized and no longer accepts chunks."
  };
}

function beginChunkUpload(
  state: RouteChunkSessionState,
  chunkIndex: number
):
  | { ok: true }
  | { ok: false; statusCode: number; body: { code: string; message: string } } {
  if (state.status !== "recording") {
    return {
      ok: false,
      statusCode: state.status === "finalized" ? 410 : 409,
      body: sessionClosedBody(state.status)
    };
  }

  if (state.reservedChunkIndexes.has(chunkIndex)) {
    return {
      ok: false,
      statusCode: 409,
      body: duplicateChunkBody(chunkIndex)
    };
  }

  state.reservedChunkIndexes.add(chunkIndex);
  state.activeChunkUploads += 1;
  return { ok: true };
}

function endChunkUpload(state: RouteChunkSessionState, chunkIndex: number): void {
  state.reservedChunkIndexes.delete(chunkIndex);
  state.activeChunkUploads = Math.max(0, state.activeChunkUploads - 1);
  if (state.activeChunkUploads > 0) {
    return;
  }

  const waiters = state.chunkUploadWaiters.splice(0);
  for (const resolve of waiters) {
    resolve();
  }
}

function waitForChunkUploads(state: RouteChunkSessionState): Promise<void> {
  if (state.activeChunkUploads === 0) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    state.chunkUploadWaiters.push(resolve);
  });
}

async function trackChunkQueueCompletion(input: {
  state: RouteChunkSessionState;
  chunkIndex: number;
  enqueuePromise: Promise<void>;
  events: SessionEventHub;
}): Promise<void> {
  try {
    await input.enqueuePromise;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Chunk queue failed.";
    try {
      await markChunkFailed({
        session: input.state.session,
        chunkIndex: input.chunkIndex,
        code: "CHUNK_QUEUE_FAILED",
        message
      });
      input.events.publish({
        type: "chunk-failed",
        sessionId: input.state.session.id,
        chunkIndex: input.chunkIndex,
        code: "CHUNK_QUEUE_FAILED",
        message
      });
    } catch {
      // This runs after the upload response is accepted. Keep the queue rejection handled even if persistence fails.
    }
  } finally {
    endChunkUpload(input.state, input.chunkIndex);
  }
}

function duplicateChunkBody(chunkIndex: number): { code: string; message: string } {
  return {
    code: "DUPLICATE_CHUNK_INDEX",
    message: `Chunk index ${chunkIndex} has already been uploaded.`
  };
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
