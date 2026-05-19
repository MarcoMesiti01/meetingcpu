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
      const response = await fetchService(fetchImpl, `${normalizedBaseUrl}/health`);
      await throwIfServiceError(response);
      return response.json() as Promise<{ ok: boolean; service: string }>;
    },

    async transcribe(input: TranscriptionRequest): Promise<TranscriptResult> {
      const response = await fetchService(fetchImpl, `${normalizedBaseUrl}/transcribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      });

      await throwIfServiceError(response);
      return response.json() as Promise<TranscriptResult>;
    }
  };
}

async function fetchService(fetchImpl: FetchLike, url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    throw createServiceError(
      `Transcription service is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      "TRANSCRIPTION_SERVICE_UNREACHABLE",
      0
    );
  }
}

async function throwIfServiceError(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }

  const payload = await response.json().catch(() => null);
  const detail = readErrorDetail(payload);
  throw createServiceError(
    detail.message ?? `Transcription service failed with HTTP ${response.status}`,
    detail.code ?? "TRANSCRIPTION_SERVICE_ERROR",
    response.status
  );
}

function readErrorDetail(payload: unknown): { code?: string; message?: string } {
  if (!isRecord(payload) || !isRecord(payload.detail)) {
    return {};
  }

  return {
    code: typeof payload.detail.code === "string" ? payload.detail.code : undefined,
    message: typeof payload.detail.message === "string" ? payload.detail.message : undefined
  };
}

function createServiceError(message: string, code: string, status: number): TranscriptionServiceError {
  const error = new Error(message) as TranscriptionServiceError;
  error.code = code;
  error.status = status;
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
