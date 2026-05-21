import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChildProcess, type SpawnOptions } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { resolveFfmpegPath, splitAudioIntoChunks } from "./ffmpegChunks.js";

describe("ffmpeg chunk helpers", () => {
  it("prefers FFMPEG_PATH when it is usable", async () => {
    const spawn = vi.fn(fakeSpawnSuccess);
    const exists = vi.fn(async (path: string) => path === "C:\\bin\\ffmpeg.exe");

    await expect(
      resolveFfmpegPath({
        env: { FFMPEG_PATH: "C:\\bin\\ffmpeg.exe" },
        exists,
        spawn
      })
    ).resolves.toBe("C:\\bin\\ffmpeg.exe");

    expect(spawn).toHaveBeenCalledWith(
      "C:\\bin\\ffmpeg.exe",
      ["-version"],
      expect.objectContaining({ stdio: "ignore" })
    );
    expect(spawn).not.toHaveBeenCalledWith("ffmpeg", expect.anything(), expect.anything());
  });

  it("returns null when ffmpeg cannot be resolved", async () => {
    const spawn = vi.fn(fakeSpawnFailure);

    await expect(
      resolveFfmpegPath({
        env: {},
        exists: vi.fn(async () => false),
        spawn
      })
    ).resolves.toBeNull();
  });

  it("splits with 30-second segment arguments and a local output pattern", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const inputPath = join(dataRoot, "upload.webm");
    const outputDirectory = join(dataRoot, "chunks");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(inputPath, "audio");

    const spawn = vi.fn(fakeSpawnWithChunks(outputDirectory));

    const chunks = await splitAudioIntoChunks({
      ffmpegPath: "C:\\bin\\ffmpeg.exe",
      inputPath,
      outputDirectory,
      outputPattern: join(outputDirectory, "chunk-%06d.webm"),
      spawn
    });

    expect(chunks).toEqual([
      {
        index: 0,
        path: join(outputDirectory, "chunk-000000.webm"),
        startSeconds: 0,
        endSeconds: 30,
        durationSeconds: 30
      },
      {
        index: 1,
        path: join(outputDirectory, "chunk-000001.webm"),
        startSeconds: 30,
        endSeconds: 60,
        durationSeconds: 30
      }
    ]);
    expect(spawn).toHaveBeenCalledWith(
      "C:\\bin\\ffmpeg.exe",
      expect.arrayContaining([
        "-i",
        inputPath,
        "-segment_time",
        "30",
        "-reset_timestamps",
        "1",
        join(outputDirectory, "chunk-%06d.webm")
      ]),
      expect.objectContaining<SpawnOptions>({ stdio: "ignore" })
    );
  });

  it("uses ffmpeg segment list timings when the final chunk is shorter", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const inputPath = join(dataRoot, "upload.webm");
    const outputDirectory = join(dataRoot, "chunks");
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(inputPath, "audio");

    const spawn = vi.fn(fakeSpawnWithSegmentList(outputDirectory));

    const chunks = await splitAudioIntoChunks({
      ffmpegPath: "C:\\bin\\ffmpeg.exe",
      inputPath,
      outputDirectory,
      outputPattern: join(outputDirectory, "chunk-%06d.webm"),
      spawn
    });

    expect(chunks).toEqual([
      {
        index: 0,
        path: join(outputDirectory, "chunk-000000.webm"),
        startSeconds: 0,
        endSeconds: 30,
        durationSeconds: 30
      },
      {
        index: 1,
        path: join(outputDirectory, "chunk-000001.webm"),
        startSeconds: 30,
        endSeconds: 35.25,
        durationSeconds: 5.25
      }
    ]);
    expect(spawn).toHaveBeenCalledWith(
      "C:\\bin\\ffmpeg.exe",
      expect.arrayContaining(["-segment_list", join(outputDirectory, "chunks.csv"), "-segment_list_type", "csv"]),
      expect.objectContaining<SpawnOptions>({ stdio: "ignore" })
    );
  });
});

function fakeSpawnSuccess(_command: string, _args: string[], _options: SpawnOptions): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  queueMicrotask(() => {
    child.emit("close", 0, null);
  });
  return child;
}

function fakeSpawnFailure(_command: string, _args: string[], _options: SpawnOptions): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  queueMicrotask(() => {
    child.emit("error", new Error("ffmpeg unavailable"));
  });
  return child;
}

function fakeSpawnWithChunks(outputDirectory: string) {
  return (_command: string, args: string[], _options: SpawnOptions): ChildProcess => {
    const child = new EventEmitter() as ChildProcess;
    void args;
    writeFileSync(join(outputDirectory, "chunk-000000.webm"), "chunk-1");
    writeFileSync(join(outputDirectory, "chunk-000001.webm"), "chunk-2");
    queueMicrotask(() => {
      child.emit("close", 0, null);
    });
    return child;
  };
}

function fakeSpawnWithSegmentList(outputDirectory: string) {
  return (_command: string, _args: string[], _options: SpawnOptions): ChildProcess => {
    const child = new EventEmitter() as ChildProcess;
    writeFileSync(join(outputDirectory, "chunk-000000.webm"), "chunk-1");
    writeFileSync(join(outputDirectory, "chunk-000001.webm"), "chunk-2");
    writeFileSync(
      join(outputDirectory, "chunks.csv"),
      "chunk-000000.webm,0.000000,30.000000\nchunk-000001.webm,30.000000,35.250000\n"
    );
    queueMicrotask(() => {
      child.emit("close", 0, null);
    });
    return child;
  };
}
