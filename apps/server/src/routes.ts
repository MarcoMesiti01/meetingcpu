import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import multer from "multer";
import { DEFAULT_MODEL_ID, listModelOptions, parseModelId, type ModelId } from "./models.js";
import { createSession, saveRecording, saveTranscript, type Session, type SourceType, type TranscriptResult } from "./sessions.js";

export interface TranscriptionClient {
  health(): Promise<{ ok: boolean; service: string }>;
  transcribe(input: { audioPath: string; modelId: ModelId; language: string | null }): Promise<TranscriptResult>;
}

export interface RouteDependencies {
  dataRoot: string;
  transcriptionClient: TranscriptionClient;
}

const MAX_AUDIO_UPLOAD_BYTES = 500 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_UPLOAD_BYTES }
});

export function createRoutes(dependencies: RouteDependencies): Router {
  const router = Router();

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
        buffer: request.file.buffer,
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
      respondWithTranscriptionError(response, error, { session, recordingPath });
    }
  }));

  return router;
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
