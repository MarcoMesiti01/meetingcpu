import concurrently from "concurrently";
import { join } from "node:path";

const isWindows = process.platform === "win32";
const python = isWindows ? join(".venv", "Scripts", "python.exe") : join(".venv", "bin", "python");

const { result } = concurrently(
  [
    {
      name: "whisper",
      command: `${quote(python)} -m uvicorn app.main:app --app-dir services/whisper --host 127.0.0.1 --port 8765`
    },
    {
      name: "server",
      command: "npm --workspace @meetingcpu/server run dev",
      env: { TRANSCRIPTION_SERVICE_URL: "http://127.0.0.1:8765" }
    },
    {
      name: "web",
      command: "npm --workspace @meetingcpu/web run dev"
    }
  ],
  {
    prefix: "name",
    killOthers: ["failure", "success"]
  }
);

await result;

function quote(value) {
  return value.includes(" ") ? `"${value}"` : value;
}
