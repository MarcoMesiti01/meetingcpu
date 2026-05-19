import { resolve } from "node:path";

export interface ServerConfig {
  port: number;
  dataRoot: string;
  transcriptionServiceUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT ?? 5174),
    dataRoot: resolve(env.MEETINGCPU_DATA_DIR ?? "data"),
    transcriptionServiceUrl: env.TRANSCRIPTION_SERVICE_URL ?? "http://127.0.0.1:8765"
  };
}
