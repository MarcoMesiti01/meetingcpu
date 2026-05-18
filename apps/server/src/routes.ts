import { Router } from "express";
import multer from "multer";
import { DEFAULT_MODEL_ID, listModelOptions, parseModelId, type ModelId } from "./models.js";
import { createSession, saveRecording, saveTranscript, type SourceType, type TranscriptResult } from "./sessions.js";

export interface TranscriptionClient {
  health(): Promise<{ ok: boolean; service: string }>;
  transcribe(input: { audioPath: string; modelId: ModelId; language: string | null }): Promise<TranscriptResult>;
}

export interface RouteDependencies {
  dataRoot: string;
  transcriptionClient: TranscriptionClient;
}

const upload = multer({ storage: multer.memoryStorage() });

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

  router.post("/transcriptions", upload.single("audio"), async (request, response) => {
    const modelResult = parseModelId(String(request.body.modelId ?? ""));
    if (!modelResult.ok) {
      response.status(400).json(modelResult.error);
      return;
    }

    if (!request.file) {
      response.status(400).json({ code: "AUDIO_REQUIRED", message: "Attach an audio file using the 'audio' field." });
      return;
    }

    const sourceType = parseSourceType(request.body.sourceType);
    const session = await createSession({
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
  });

  return router;
}

function parseSourceType(value: unknown): SourceType {
  return value === "upload" ? "upload" : "microphone";
}
