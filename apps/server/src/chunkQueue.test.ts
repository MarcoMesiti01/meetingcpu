import { describe, expect, it } from "vitest";
import { ChunkQueue, type ChunkQueueInput } from "./chunkQueue.js";
import type { SessionEvent } from "./sessionEvents.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe("chunk queue", () => {
  it("processes one chunk at a time", async () => {
    let active = 0;
    let maxActive = 0;
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const queue = new ChunkQueue({
      processChunk: async (input: ChunkQueueInput) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (input.chunkIndex === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        active -= 1;
      },
      events: { publish: () => undefined }
    });

    const first = queue.enqueue({ sessionId: "session-1", chunkIndex: 1 });
    const second = queue.enqueue({ sessionId: "session-1", chunkIndex: 2 });

    await firstStarted.promise;
    expect(maxActive).toBe(1);

    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(maxActive).toBe(1);
  });

  it("processes chunks in FIFO order", async () => {
    const processed: number[] = [];
    const queue = new ChunkQueue({
      processChunk: async (input: ChunkQueueInput) => {
        processed.push(input.chunkIndex);
      },
      events: { publish: () => undefined }
    });

    await Promise.all([
      queue.enqueue({ sessionId: "session-1", chunkIndex: 1 }),
      queue.enqueue({ sessionId: "session-1", chunkIndex: 2 }),
      queue.enqueue({ sessionId: "session-1", chunkIndex: 3 })
    ]);

    expect(processed).toEqual([1, 2, 3]);
  });

  it("emits a failed chunk event when processing fails", async () => {
    const events: SessionEvent[] = [];
    const queue = new ChunkQueue({
      processChunk: async () => {
        throw Object.assign(new Error("Whisper service failed."), { code: "TRANSCRIBE_FAILED" });
      },
      events: { publish: (event) => events.push(event) }
    });

    await expect(queue.enqueue({ sessionId: "session-1", chunkIndex: 7 })).rejects.toThrow("Whisper service failed.");

    expect(events).toEqual([
      {
        type: "chunk-failed",
        sessionId: "session-1",
        chunkIndex: 7,
        code: "TRANSCRIBE_FAILED",
        message: "Whisper service failed."
      }
    ]);
  });

  it("waits for active and queued jobs before finalization continues", async () => {
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const processed: number[] = [];
    const queue = new ChunkQueue({
      processChunk: async (input: ChunkQueueInput) => {
        if (input.chunkIndex === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        processed.push(input.chunkIndex);
      },
      events: { publish: () => undefined }
    });

    const first = queue.enqueue({ sessionId: "session-1", chunkIndex: 1 });
    const second = queue.enqueue({ sessionId: "session-1", chunkIndex: 2 });
    await firstStarted.promise;

    let finalized = false;
    const waiting = queue.waitForSession("session-1").then(() => {
      finalized = true;
    });
    await Promise.resolve();
    expect(finalized).toBe(false);

    releaseFirst.resolve();
    await Promise.all([first, second, waiting]);

    expect(finalized).toBe(true);
    expect(processed).toEqual([1, 2]);
  });
});
