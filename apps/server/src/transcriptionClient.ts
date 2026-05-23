import type { ModelId } from "./models.js";

export type FetchLike = typeof fetch;

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface DiarizationStatus {
  available: boolean;
  enabled: boolean;
  error?: string;
}

export interface TranscriptionResult {
  text: string;
  language: string;
  durationSeconds: number;
  segments: TranscriptionSegment[];
  diarization?: DiarizationStatus;
}

export interface TranscriptionRequest {
  audioPath: string;
  modelId: ModelId;
  language: string | null;
  diarization?: boolean;
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

    async transcribe(input: TranscriptionRequest): Promise<TranscriptionResult> {
      const response = await fetchService(fetchImpl, `${normalizedBaseUrl}/transcribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      });

      await throwIfServiceError(response);
      return parseTranscriptionResult(await response.json());
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

function parseTranscriptionResult(payload: unknown): TranscriptionResult {
  if (!isValidTranscriptionResult(payload)) {
    throw createServiceError(
      "Transcription service returned an invalid transcription response.",
      "TRANSCRIPTION_SERVICE_RESPONSE_INVALID",
      502
    );
  }

  return {
    text: payload.text,
    language: payload.language,
    durationSeconds: payload.durationSeconds,
    segments: payload.segments,
    ...(payload.diarization ? { diarization: payload.diarization } : {})
  };
}

function isValidTranscriptionResult(value: unknown): value is TranscriptionResult {
  return (
    isRecord(value) &&
    typeof value.text === "string" &&
    typeof value.language === "string" &&
    isFiniteNumber(value.durationSeconds) &&
    Array.isArray(value.segments) &&
    value.segments.every(isTranscriptionSegment) &&
    (value.diarization === undefined || isDiarizationStatus(value.diarization))
  );
}

function isTranscriptionSegment(value: unknown): value is TranscriptionSegment {
  return (
    isRecord(value) &&
    isFiniteNumber(value.start) &&
    isFiniteNumber(value.end) &&
    typeof value.text === "string" &&
    (value.speaker === undefined || typeof value.speaker === "string")
  );
}

function isDiarizationStatus(value: unknown): value is DiarizationStatus {
  return (
    isRecord(value) &&
    typeof value.available === "boolean" &&
    typeof value.enabled === "boolean" &&
    (value.error === undefined || typeof value.error === "string")
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
