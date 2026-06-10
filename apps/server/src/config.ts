import { join, resolve } from "node:path";

export interface ServerConfig {
  host: string;
  port: number;
  dataRoot: string;
  transcriptionServiceUrl: string;
  allowedOrigins: string[];
  enableFfmpegUploadFallback: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ServerConfig {
  return {
    host: "127.0.0.1",
    port: Number(env.MEETINGCPU_SERVER_PORT ?? env.PORT ?? 5174),
    dataRoot: resolveDataRoot(env, platform),
    transcriptionServiceUrl: env.TRANSCRIPTION_SERVICE_URL ?? "http://127.0.0.1:8765",
    allowedOrigins: parseAllowedOrigins(env.MEETINGCPU_ALLOWED_ORIGINS),
    enableFfmpegUploadFallback: env.MEETINGCPU_ENABLE_FFMPEG_UPLOAD_FALLBACK === "true"
  };
}

function resolveDataRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const dataDir = env.MEETINGCPU_DATA_DIR?.trim();
  if (dataDir) {
    return resolve(dataDir);
  }

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) {
      return join(localAppData, "meetingcpu", "data");
    }
  }

  return resolve("data");
}

function parseAllowedOrigins(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}
