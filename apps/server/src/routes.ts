import { mkdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import multer from "multer";
import { DEFAULT_MODEL_ID, listModelOptions, parseModelId, type ModelId } from "./models.js";
import {
  createSession,
  saveFailedTranscription,
  saveRecording,
  saveTranscript,
  type Session,
  type SourceType,
  type TranscriptResult
} from "./sessions.js";

export interface TranscriptionClient {
  health(): Promise<{ ok: boolean; service: string }>;
  transcribe(input: { audioPath: string; modelId: ModelId; language: string | null }): Promise<TranscriptResult>;
}

export interface RouteDependencies {
  dataRoot: string;
  transcriptionClient: TranscriptionClient;
  maxAudioUploadBytes?: number;
}

const MAX_AUDIO_UPLOAD_BYTES = 500 * 1024 * 1024;

export function createRoutes(dependencies: RouteDependencies): Router {
  const router = Router();
  const maxAudioUploadBytes = dependencies.maxAudioUploadBytes ?? MAX_AUDIO_UPLOAD_BYTES;
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

    let session: Session | null = null;
    let recordingPath: string | null = null;

    try {
      const sourceType = parseSourceType(request.body.sourceType);
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

function isNodeError(error: unknown): error is Error & { code?: string } {
  return error instanceof Error && "code" in error;
}
