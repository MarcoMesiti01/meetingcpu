import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const isWindows = process.platform === "win32";
const venvPython = isWindows ? join(".venv", "Scripts", "python.exe") : join(".venv", "bin", "python");
const pythonCommand = process.env.PYTHON ?? (isWindows ? "py" : "python3");
const pythonArgs = process.env.PYTHON ? [] : isWindows ? ["-3"] : [];

if (!existsSync(venvPython)) {
  run(pythonCommand, [...pythonArgs, "-m", "venv", ".venv"], "create Python virtual environment");
}

run(venvPython, ["-m", "pip", "install", "--upgrade", "pip"], "upgrade pip");
run(venvPython, ["-m", "pip", "install", "-r", "services/whisper/requirements.txt"], "install whisper service dependencies");
run(venvPython, ["scripts/download-model.py", "small"], "download default small model");

function run(command, args, label) {
  console.log(`[setup] ${label}`);
  const result = spawnSync(command, args, { stdio: "inherit", shell: false });
  if (result.status !== 0) {
    console.error(`[setup] Failed to ${label}.`);
    process.exit(result.status ?? 1);
  }
}
