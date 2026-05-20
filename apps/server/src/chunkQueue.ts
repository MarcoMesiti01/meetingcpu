import type { SessionEvent } from "./sessionEvents.js";

export interface ChunkQueueInput {
  sessionId: string;
  chunkIndex: number;
}

export interface ChunkQueueOptions<TInput extends ChunkQueueInput> {
  processChunk(input: TInput): Promise<void>;
  events: {
    publish(event: SessionEvent): void;
  };
}

interface QueuedJob<TInput extends ChunkQueueInput> {
  input: TInput;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface SessionWaiter {
  sessionId: string;
  resolve: () => void;
}

export class ChunkQueue<TInput extends ChunkQueueInput = ChunkQueueInput> {
  private readonly processChunk: (input: TInput) => Promise<void>;
  private readonly events: { publish(event: SessionEvent): void };
  private readonly jobs: QueuedJob<TInput>[] = [];
  private readonly waiters: SessionWaiter[] = [];
  private activeJob: QueuedJob<TInput> | null = null;
  private isProcessing = false;

  constructor(options: ChunkQueueOptions<TInput>) {
    this.processChunk = options.processChunk;
    this.events = options.events;
  }

  enqueue(input: TInput): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
      this.jobs.push({ input, resolve, reject });
    });
    this.processNext();
    return promise;
  }

  waitForSession(sessionId: string): Promise<void> {
    if (!this.hasPendingSessionWork(sessionId)) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.waiters.push({ sessionId, resolve });
    });
  }

  private processNext(): void {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;
    void this.drain();
  }

  private async drain(): Promise<void> {
    try {
      for (;;) {
        const job = this.jobs.shift();
        if (!job) {
          return;
        }

        this.activeJob = job;
        try {
          await this.processChunk(job.input);
          job.resolve();
        } catch (error) {
          this.publishFailure(job.input, error);
          job.reject(error);
        } finally {
          this.activeJob = null;
          this.resolveReadyWaiters();
        }
      }
    } finally {
      this.isProcessing = false;
      if (this.jobs.length > 0) {
        this.processNext();
      }
    }
  }

  private publishFailure(input: TInput, error: unknown): void {
    this.events.publish({
      type: "chunk-failed",
      sessionId: input.sessionId,
      chunkIndex: input.chunkIndex,
      code: errorCode(error),
      message: errorMessage(error)
    });
  }

  private hasPendingSessionWork(sessionId: string): boolean {
    return this.activeJob?.input.sessionId === sessionId || this.jobs.some((job) => job.input.sessionId === sessionId);
  }

  private resolveReadyWaiters(): void {
    for (let index = 0; index < this.waiters.length; ) {
      const waiter = this.waiters[index];
      if (this.hasPendingSessionWork(waiter.sessionId)) {
        index += 1;
        continue;
      }

      this.waiters.splice(index, 1);
      waiter.resolve();
    }
  }
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }

  return "CHUNK_PROCESSING_FAILED";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Chunk processing failed.";
}
