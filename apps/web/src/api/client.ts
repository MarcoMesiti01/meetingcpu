export interface ModelOption {
  id: string;
  label: string;
  warning?: string;
  recommended: boolean;
}

export interface ModelsResponse {
  defaultModelId: string;
  models: ModelOption[];
}

export interface TranscribeAudioInput {
  audio: Blob;
  fileName: string;
  modelId: string;
  sourceType: "microphone" | "upload";
  title: string;
}

export interface CreateSessionInput {
  title: string;
  modelId: string;
  language?: string;
  diarization?: boolean;
}

export interface CreateSessionResponse {
  sessionId: string;
  sessionPath: string;
  inProgressTranscriptPath: string;
}

export interface UploadSessionChunkInput {
  sessionId: string;
  audio: Blob;
  fileName: string;
  chunkIndex: number;
  startSeconds: number;
  endSeconds: number;
  overlapSeconds: number;
  modelId?: string;
  sourceType?: "microphone" | "upload";
  mimeType?: string;
}

export interface UploadSessionChunkResponse {
  sessionId: string;
  chunkIndex: number;
  status: "queued";
}

export interface FinalizeSessionResponse {
  sessionId: string;
  transcriptPath: string;
  transcriptJsonPath: string;
  partial: boolean;
}

export type SessionEvent =
  | { type: "session-created"; sessionId: string; sessionPath: string; inProgressTranscriptPath: string }
  | { type: "chunk-saved"; sessionId: string; chunkIndex: number }
  | {
      type: "chunk-transcribed";
      sessionId: string;
      chunkIndex: number;
      text: string;
      diarization: { available: boolean; enabled: boolean; error?: string };
    }
  | { type: "chunk-failed"; sessionId: string; chunkIndex: number; code: string; message: string }
  | { type: "session-finalized"; sessionId: string; transcriptPath: string; partial: boolean };

export interface SessionEventHandlers {
  onEvent: (event: SessionEvent) => void;
  onError?: (error: Error) => void;
}

export interface SessionEventConnection {
  close(): void;
}

const TRANSCRIPTION_FAILED_MESSAGE = "Transcription failed.";
const MODELS_FAILED_MESSAGE = "Could not load model options.";
const SESSION_FAILED_MESSAGE = "Session request failed.";
const SESSION_EVENT_TYPES = [
  "session-created",
  "chunk-saved",
  "chunk-transcribed",
  "chunk-failed",
  "session-finalized"
];

export function createApiClient(fetchImpl: typeof fetch = fetch, EventSourceCtor?: typeof EventSource) {
  return {
    async getModels(): Promise<ModelsResponse> {
      const response = await fetchOrThrow(fetchImpl, "/api/models", undefined, MODELS_FAILED_MESSAGE);
      if (!response.ok) throw new Error(await readErrorMessage(response, MODELS_FAILED_MESSAGE));
      return response.json() as Promise<ModelsResponse>;
    },

    async transcribeAudio(input: TranscribeAudioInput) {
      const form = new FormData();
      form.set("audio", input.audio, input.fileName);
      form.set("modelId", input.modelId);
      form.set("sourceType", input.sourceType);
      form.set("title", input.title);

      const response = await fetchOrThrow(fetchImpl, "/api/transcriptions", {
        method: "POST",
        body: form
      }, TRANSCRIPTION_FAILED_MESSAGE);
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, TRANSCRIPTION_FAILED_MESSAGE));
      }
      return response.json();
    },

    async createSession(input: CreateSessionInput): Promise<CreateSessionResponse> {
      const response = await fetchOrThrow(fetchImpl, "/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input)
      }, SESSION_FAILED_MESSAGE);
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, SESSION_FAILED_MESSAGE));
      }
      return response.json() as Promise<CreateSessionResponse>;
    },

    async uploadSessionChunk(input: UploadSessionChunkInput): Promise<UploadSessionChunkResponse> {
      const form = new FormData();
      form.set("audio", input.audio, input.fileName);
      form.set("chunkIndex", String(input.chunkIndex));
      form.set("startSeconds", String(input.startSeconds));
      form.set("endSeconds", String(input.endSeconds));
      form.set("overlapSeconds", String(input.overlapSeconds));
      if (input.modelId) form.set("modelId", input.modelId);
      if (input.sourceType) form.set("sourceType", input.sourceType);
      if (input.mimeType) form.set("mimeType", input.mimeType);

      const response = await fetchOrThrow(fetchImpl, `/api/sessions/${encodeURIComponent(input.sessionId)}/chunks`, {
        method: "POST",
        body: form
      }, SESSION_FAILED_MESSAGE);
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, SESSION_FAILED_MESSAGE));
      }
      return response.json() as Promise<UploadSessionChunkResponse>;
    },

    async finalizeSession(sessionId: string): Promise<FinalizeSessionResponse> {
      const response = await fetchOrThrow(fetchImpl, `/api/sessions/${encodeURIComponent(sessionId)}/finalize`, {
        method: "POST"
      }, SESSION_FAILED_MESSAGE);
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, SESSION_FAILED_MESSAGE));
      }
      return response.json() as Promise<FinalizeSessionResponse>;
    },

    subscribeToSessionEvents(sessionId: string, handlers: SessionEventHandlers): SessionEventConnection {
      const SourceCtor = EventSourceCtor ?? globalThis.EventSource;
      if (!SourceCtor) {
        throw new Error("Session event streaming is not supported in this browser.");
      }
      const eventSource = new SourceCtor(`/api/sessions/${encodeURIComponent(sessionId)}/events`);
      for (const eventType of SESSION_EVENT_TYPES) {
        eventSource.addEventListener(eventType, (event) => {
          let parsedEvent: SessionEvent;
          try {
            parsedEvent = JSON.parse(event.data) as SessionEvent;
          } catch {
            handlers.onError?.(new Error("Could not parse session event."));
            return;
          }
          try {
            handlers.onEvent(parsedEvent);
          } catch (error) {
            handlers.onError?.(normalizeError(error));
          }
        });
      }
      eventSource.onerror = () => {
        handlers.onError?.(new Error("Session event stream failed."));
      };
      return {
        close: () => eventSource.close()
      };
    }
  };
}

async function fetchOrThrow(
  fetchImpl: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  failureMessage: string
) {
  try {
    return await fetchImpl(input, init);
  } catch {
    throw new Error(failureMessage);
  }
}

async function readErrorMessage(response: Response, fallback: string) {
  try {
    const payload = await response.json() as { message?: unknown };
    if (typeof payload.message === "string" && payload.message.trim().length > 0) {
      return payload.message;
    }
  } catch {
    // Some backend failures are empty or plain text. Keep the UI error stable.
  }
  return fallback;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
