import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { access, mkdir, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

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

export interface FfmpegAudioChunk {
  index: number;
  path: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
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

export async function splitAudioIntoChunks(input: SplitAudioIntoChunksInput): Promise<FfmpegAudioChunk[]> {
  const spawnImpl = input.spawn ?? nodeSpawn;
  const segmentSeconds = input.segmentSeconds ?? 30;
  await mkdir(input.outputDirectory, { recursive: true });
  const segmentListPath = join(input.outputDirectory, "chunks.csv");

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
      String(segmentSeconds),
      "-segment_list",
      segmentListPath,
      "-segment_list_type",
      "csv",
      "-reset_timestamps",
      "1",
      input.outputPattern
    ],
    { stdio: "ignore", windowsHide: true }
  );

  await waitForClose(child);

  const segmentTimings = await readSegmentTimings(segmentListPath);
  return (await readdir(input.outputDirectory))
    .filter((fileName) => /^chunk-\d{6}\.[^.]+$/.test(fileName))
    .sort()
    .map((fileName, index) => {
      const timing = segmentTimings.get(fileName);
      const startSeconds = timing?.startSeconds ?? index * segmentSeconds;
      const endSeconds = timing?.endSeconds ?? startSeconds + segmentSeconds;
      return {
        index,
        path: join(input.outputDirectory, fileName),
        startSeconds,
        endSeconds,
        durationSeconds: endSeconds - startSeconds
      };
    });
}

async function readSegmentTimings(
  segmentListPath: string
): Promise<Map<string, { startSeconds: number; endSeconds: number }>> {
  try {
    const rows = (await readFile(segmentListPath, "utf8")).split(/\r?\n/);
    const timings = new Map<string, { startSeconds: number; endSeconds: number }>();
    for (const row of rows) {
      const columns = parseCsvRow(row);
      if (columns.length < 3) {
        continue;
      }

      const startSeconds = Number(columns[1]);
      const endSeconds = Number(columns[2]);
      if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
        continue;
      }
      timings.set(basename(columns[0]), { startSeconds, endSeconds });
    }
    return timings;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return new Map();
    }
    throw error;
  }
}

function parseCsvRow(row: string): string[] {
  const columns: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index];
    if (character === '"') {
      if (quoted && row[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (character === "," && !quoted) {
      columns.push(value);
      value = "";
      continue;
    }
    value += character;
  }
  columns.push(value);
  return columns;
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

function isNodeError(error: unknown): error is Error & { code?: string } {
  return error instanceof Error && "code" in error;
}
