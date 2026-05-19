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

const TRANSCRIPTION_FAILED_MESSAGE = "Transcription failed.";
const MODELS_FAILED_MESSAGE = "Could not load model options.";

export function createApiClient(fetchImpl: typeof fetch = fetch) {
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
