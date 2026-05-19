import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const isWindows = process.platform === "win32";
const venvPython = isWindows ? join(".venv", "Scripts", "python.exe") : join(".venv", "bin", "python");
const pythonCommand = process.env.PYTHON ?? (isWindows ? "py" : "python3");
const pythonArgs = process.env.PYTHON ? [] : isWindows ? ["-3"] : [];
const pythonHint = "Install Python 3.9+ or set PYTHON to a Python executable path.";

if (!existsSync(venvPython)) {
  const venvArgs = [...pythonArgs, "-m", "venv", ".venv"];
  const result = run(pythonCommand, venvArgs, "create Python virtual environment", {
    hint: pythonHint,
    exitOnFailure: false,
  });

  if (result.status !== 0 || result.error) {
    if (!process.env.PYTHON && isWindows && result.error?.code === "ENOENT") {
      console.error("[setup] Python launcher not found; trying python instead.");
      run("python", ["-m", "venv", ".venv"], "create Python virtual environment", { hint: pythonHint });
    } else {
      fail(result, "create Python virtual environment", pythonHint);
    }
  }
}

run(venvPython, ["-m", "pip", "install", "--upgrade", "pip"], "upgrade pip");
run(venvPython, ["-m", "pip", "install", "-r", "services/whisper/requirements.txt"], "install whisper service dependencies");
run(venvPython, ["scripts/download-model.py", "small"], "download default small model");

function run(command, args, label, options = {}) {
  console.log(`[setup] ${label}`);
  const result = spawnSync(command, args, { stdio: "inherit", shell: false });
  if (result.error) {
    console.error(`[setup] Attempted: ${[command, ...args].join(" ")}`);
    console.error(`[setup] Error: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (options.exitOnFailure === false) {
      return result;
    }
    fail(result, label, options.hint);
  }
  return result;
}

function fail(result, label, hint) {
  console.error(`[setup] Failed to ${label}.`);
  if (hint) {
    console.error(`[setup] Hint: ${hint}`);
  }
  process.exit(result.status ?? 1);
}
