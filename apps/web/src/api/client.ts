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

export function createApiClient(fetchImpl: typeof fetch = fetch) {
  return {
    async getModels(): Promise<ModelsResponse> {
      const response = await fetchImpl("/api/models");
      if (!response.ok) throw new Error("Could not load model options.");
      return response.json() as Promise<ModelsResponse>;
    },

    async transcribeAudio(input: TranscribeAudioInput) {
      const form = new FormData();
      form.set("audio", input.audio, input.fileName);
      form.set("modelId", input.modelId);
      form.set("sourceType", input.sourceType);
      form.set("title", input.title);

      const response = await fetchImpl("/api/transcriptions", {
        method: "POST",
        body: form
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message ?? "Transcription failed.");
      }
      return payload;
    }
  };
}
