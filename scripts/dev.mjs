import concurrently from "concurrently";
import { join } from "node:path";
import { reportProcessFailure } from "./dev-result.mjs";

const isWindows = process.platform === "win32";
const python = isWindows ? join(".venv", "Scripts", "python.exe") : join(".venv", "bin", "python");
const whisperPort = process.env.MEETINGCPU_WHISPER_PORT ?? "8765";
const webPort = process.env.MEETINGCPU_WEB_PORT ?? "5173";
const serverPort = process.env.MEETINGCPU_SERVER_PORT ?? process.env.PORT ?? "5174";

const { result } = concurrently(
  [
    {
      name: "whisper",
      command: `${quote(python)} -m uvicorn app.main:app --app-dir services/whisper --host 127.0.0.1 --port ${quote(whisperPort)}`
    },
    {
      name: "server",
      command: "npm --workspace @meetingcpu/server run dev",
      env: {
        PORT: serverPort,
        TRANSCRIPTION_SERVICE_URL: `http://127.0.0.1:${whisperPort}`
      }
    },
    {
      name: "web",
      command: `npm --workspace @meetingcpu/web run dev -- --host 127.0.0.1 --port ${quote(webPort)}`
    }
  ],
  {
    prefix: "name",
    killOthers: ["failure", "success"]
  }
);

try {
  await result;
} catch (failures) {
  reportProcessFailure(failures);
  process.exitCode = 1;
}

function quote(value) {
  return value.includes(" ") ? `"${value}"` : value;
}
