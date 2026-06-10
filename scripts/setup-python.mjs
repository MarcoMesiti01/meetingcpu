import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const isWindows = process.platform === "win32";
const venvPython = isWindows ? join(".venv", "Scripts", "python.exe") : join(".venv", "bin", "python");
const pythonCommand = process.env.PYTHON ?? (isWindows ? "py" : "python3");
const pythonArgs = process.env.PYTHON ? [] : isWindows ? ["-3"] : [];
const pythonHint = "Install Python 3.9+ or set PYTHON to a Python executable path.";
const args = process.argv.slice(2);
const downloadOnly = args[0] === "--download-model";
const downloadDiarization = args[0] === "--download-diarization";
const testPython = args[0] === "--test-python";
const modelIds = downloadOnly ? args.slice(1) : ["small"];

if (process.env.MEETINGCPU_SKIP_PYTHON_SETUP === "true" && args.length === 0) {
  console.log("[setup] Skipping Python setup because MEETINGCPU_SKIP_PYTHON_SETUP=true.");
  process.exit(0);
}

if (testPython) {
  const pytestTemp = join(process.cwd(), ".pytest_tmp", `${process.pid}-${Date.now()}`);
  mkdirSync(pytestTemp, { recursive: true });
  run(
    venvPython,
    ["-m", "pytest", "-p", "no:cacheprovider", "--basetemp", join(pytestTemp, "basetemp"), "services/whisper/tests"],
    "run whisper service tests",
    {
      env: {
        ...process.env,
        TEMP: pytestTemp,
        TMP: pytestTemp
      },
      hint: "Run npm install first to create the Python virtual environment and install test dependencies."
    }
  );
  process.exit(0);
}

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
if (downloadDiarization) {
  run(
    venvPython,
    ["-m", "pip", "install", "pyannote.audio", "truststore"],
    "install optional diarization dependencies"
  );
  run(
    venvPython,
    ["scripts/download-diarization.py", ...args.slice(1)],
    "download diarization model"
  );
  process.exit(0);
}
for (const modelId of modelIds.length > 0 ? modelIds : ["small"]) {
  run(
    venvPython,
    ["scripts/download-model.py", modelId],
    downloadOnly ? `download ${modelId} model` : "download default small model"
  );
}

function run(command, args, label, options = {}) {
  console.log(`[setup] ${label}`);
  const result = spawnSync(command, args, { stdio: "inherit", shell: false, env: options.env ?? process.env });
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
