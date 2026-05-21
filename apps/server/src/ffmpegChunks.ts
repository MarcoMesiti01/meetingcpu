import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { access, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface FfmpegChunkingDependencies {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => Promise<boolean>;
  spawn?: typeof nodeSpawn;
}

export interface SplitAudioIntoChunksInput extends FfmpegChunkingDependencies {
  ffmpegPath: string;
  inputPath: string;
  outputDirectory: string;
  outputPattern: string;
  segmentSeconds?: number;
}

export async function resolveFfmpegPath(dependencies: FfmpegChunkingDependencies = {}): Promise<string | null> {
  const envPath = dependencies.env?.FFMPEG_PATH?.trim();
  if (envPath && (await pathExists(envPath, dependencies.exists))) {
    if (await probeFfmpeg(envPath, dependencies.spawn ?? nodeSpawn)) {
      return envPath;
    }
  }

  if (await probeFfmpeg("ffmpeg", dependencies.spawn ?? nodeSpawn)) {
    return "ffmpeg";
  }

  return null;
}

export async function splitAudioIntoChunks(input: SplitAudioIntoChunksInput): Promise<string[]> {
  const spawnImpl = input.spawn ?? nodeSpawn;
  await mkdir(input.outputDirectory, { recursive: true });

  const child = spawnImpl(
    input.ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      input.inputPath,
      "-f",
      "segment",
      "-segment_time",
      String(input.segmentSeconds ?? 30),
      "-reset_timestamps",
      "1",
      input.outputPattern
    ],
    { stdio: "ignore", windowsHide: true }
  );

  await waitForClose(child);

  return (await readdir(input.outputDirectory))
    .filter((fileName) => /^chunk-\d{6}\.[^.]+$/.test(fileName))
    .sort()
    .map((fileName) => join(input.outputDirectory, fileName));
}

async function pathExists(path: string, exists?: (path: string) => Promise<boolean>): Promise<boolean> {
  if (exists) {
    try {
      return await exists(path);
    } catch {
      return false;
    }
  }

  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function probeFfmpeg(command: string, spawnImpl: typeof nodeSpawn): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(ok);
    };

    const child = spawnImpl(command, ["-version"], { stdio: "ignore", windowsHide: true } satisfies SpawnOptions);
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

async function waitForClose(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg exited with code ${String(code ?? "unknown")}`));
    });
  });
}
