import type { ModelId } from "./models.js";
import type { TranscriptResult } from "./sessions.js";

export type FetchLike = typeof fetch;

export interface TranscriptionRequest {
  audioPath: string;
  modelId: ModelId;
  language: string | null;
}

export interface TranscriptionServiceError extends Error {
  code: string;
  status: number;
}

export function createTranscriptionClient(baseUrl: string, fetchImpl: FetchLike = fetch) {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");

  return {
    async health(): Promise<{ ok: boolean; service: string }> {
      const response = await fetchImpl(`${normalizedBaseUrl}/health`);
      return response.json() as Promise<{ ok: boolean; service: string }>;
    },

    async transcribe(input: TranscriptionRequest): Promise<TranscriptResult> {
      const response = await fetchImpl(`${normalizedBaseUrl}/transcribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({ detail: null }));
        const detail = payload.detail ?? {};
        const error = new Error(
          detail.message ?? `Transcription service failed with HTTP ${response.status}`
        ) as TranscriptionServiceError;
        error.code = detail.code ?? "TRANSCRIPTION_SERVICE_ERROR";
        error.status = response.status;
        throw error;
      }

      return response.json() as Promise<TranscriptResult>;
    }
  };
}
