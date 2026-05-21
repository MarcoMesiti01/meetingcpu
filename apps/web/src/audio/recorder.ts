type GetUserMedia = (constraints: MediaStreamConstraints) => Promise<MediaStream>;

export interface RecordedAudioChunk {
  chunkIndex: number;
  startSeconds: number;
  endSeconds: number;
  overlapSeconds: number;
  blob: Blob;
  mimeType: string;
  fileExtension: string;
  fileName: string;
}

export interface StartChunkedRecordingOptions {
  chunkSeconds?: number;
  overlapSeconds?: number;
  onChunk: (chunk: RecordedAudioChunk) => void | Promise<void>;
}

const DEFAULT_CHUNK_SECONDS = 30;
const DEFAULT_OVERLAP_SECONDS = 5;
const DEFAULT_MIME_TYPE = "audio/webm";

export class BrowserAudioRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private startInProgress = false;
  private chunkOptions: Required<StartChunkedRecordingOptions> | null = null;
  private nextChunkIndex = 1;
  private pendingChunkCallbacks = new Set<Promise<void>>();
  private chunkCallbackError: unknown = null;
  private chunkRecordingStartedAtMs = 0;
  private lastChunkEndSeconds = 0;

  constructor(
    private readonly getUserMedia: GetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices),
    private readonly MediaRecorderCtor: typeof MediaRecorder = MediaRecorder,
    private readonly now: () => number = () => globalThis.performance?.now() ?? Date.now()
  ) {}

  async start(): Promise<void> {
    if (this.startInProgress || this.mediaRecorder) {
      throw new Error("Recording is already in progress.");
    }

    this.startInProgress = true;

    try {
      const stream = await this.getUserMedia({ audio: true });
      this.stream = stream;
      this.chunks = [];
      this.chunkOptions = null;
      this.nextChunkIndex = 1;
      this.pendingChunkCallbacks.clear();
      this.chunkCallbackError = null;
      this.chunkRecordingStartedAtMs = 0;
      this.lastChunkEndSeconds = 0;

      const mediaRecorder = new this.MediaRecorderCtor(stream);
      this.mediaRecorder = mediaRecorder;
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.chunks.push(event.data);
        } else if (this.chunks.length === 0) {
          this.chunks.push(event.data);
        }
      };
      mediaRecorder.start();
    } catch (error) {
      this.reset();
      throw error;
    } finally {
      this.startInProgress = false;
    }
  }

  async startChunked(options: StartChunkedRecordingOptions): Promise<void> {
    if (this.startInProgress || this.mediaRecorder) {
      throw new Error("Recording is already in progress.");
    }

    this.startInProgress = true;

    try {
      const stream = await this.getUserMedia({ audio: true });
      this.stream = stream;
      this.chunks = [];
      this.nextChunkIndex = 1;
      this.pendingChunkCallbacks.clear();
      this.chunkCallbackError = null;
      this.lastChunkEndSeconds = 0;
      const chunkSeconds = options.chunkSeconds ?? DEFAULT_CHUNK_SECONDS;
      const overlapSeconds = options.overlapSeconds ?? DEFAULT_OVERLAP_SECONDS;
      this.chunkOptions = {
        chunkSeconds,
        overlapSeconds,
        onChunk: options.onChunk
      };

      const mediaRecorder = new this.MediaRecorderCtor(stream);
      this.mediaRecorder = mediaRecorder;
      mediaRecorder.ondataavailable = (event) => {
        this.trackChunkedData(event.data);
      };
      this.chunkRecordingStartedAtMs = this.now();
      mediaRecorder.start(cadenceMilliseconds(chunkSeconds, overlapSeconds));
    } catch (error) {
      this.reset();
      throw error;
    } finally {
      this.startInProgress = false;
    }
  }

  async stop(): Promise<Blob> {
    if (!this.mediaRecorder) {
      if (this.chunkCallbackError) {
        const error = this.chunkCallbackError;
        this.reset();
        throw normalizeError(error);
      }
      throw new Error("Recording has not started.");
    }

    const recorder = this.mediaRecorder;
    return new Promise((resolve, reject) => {
      recorder.onstop = () => {
        void (async () => {
          try {
            await this.waitForPendingChunkCallbacks();
            if (this.chunkCallbackError) {
              throw this.chunkCallbackError;
            }
            const chunks = this.chunks;
            const type = chunks[0]?.type || DEFAULT_MIME_TYPE;
            this.reset();
            resolve(new Blob(chunks, { type }));
          } catch (error) {
            this.reset();
            reject(normalizeError(error));
          }
        })();
      };
      try {
        recorder.stop();
      } catch (error) {
        void (async () => {
          try {
            await this.waitForPendingChunkCallbacks();
          } finally {
            this.reset();
            reject(normalizeError(error));
          }
        })();
      }
    });
  }

  private trackChunkedData(blob: Blob) {
    const pending = this.handleChunkedData(blob).catch((error) => {
      this.chunkCallbackError = this.chunkCallbackError ?? error;
      throw error;
    });
    this.pendingChunkCallbacks.add(pending);
    pending.then(
      () => this.pendingChunkCallbacks.delete(pending),
      () => this.pendingChunkCallbacks.delete(pending)
    );
    pending.catch(() => undefined);
  }

  private async waitForPendingChunkCallbacks() {
    while (this.pendingChunkCallbacks.size > 0) {
      const results = await Promise.allSettled([...this.pendingChunkCallbacks]);
      for (const result of results) {
        if (result.status === "rejected") {
          this.chunkCallbackError = this.chunkCallbackError ?? result.reason;
        }
      }
    }
  }

  private async handleChunkedData(blob: Blob) {
    if (blob.size <= 0 || !this.chunkOptions) {
      return;
    }

    const chunkIndex = this.nextChunkIndex;
    this.nextChunkIndex += 1;
    this.chunks.push(blob);

    const elapsedSeconds = Math.max(0, (this.now() - this.chunkRecordingStartedAtMs) / 1000);
    const startSeconds = this.lastChunkEndSeconds;
    const endSeconds = Math.max(startSeconds, elapsedSeconds);
    this.lastChunkEndSeconds = endSeconds;
    const mimeType = blob.type || DEFAULT_MIME_TYPE;
    const fileExtension = extensionForMimeType(mimeType);

    await this.chunkOptions.onChunk({
      chunkIndex,
      startSeconds,
      endSeconds,
      overlapSeconds: effectiveOverlapSeconds(chunkIndex, startSeconds, endSeconds, this.chunkOptions.overlapSeconds),
      blob,
      mimeType,
      fileExtension,
      fileName: `chunk-${chunkIndex.toString().padStart(6, "0")}.${fileExtension}`
    });
  }

  private cleanupMedia() {
    if (this.mediaRecorder) {
      this.mediaRecorder.ondataavailable = null;
      this.mediaRecorder.onstop = null;
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.mediaRecorder = null;
    this.stream = null;
    this.chunkOptions = null;
  }

  private reset() {
    this.cleanupMedia();
    this.chunks = [];
    this.chunkOptions = null;
    this.nextChunkIndex = 1;
    this.pendingChunkCallbacks.clear();
    this.chunkCallbackError = null;
    this.chunkRecordingStartedAtMs = 0;
    this.lastChunkEndSeconds = 0;
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes("mp4")) {
    return "mp4";
  }
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) {
    return "mp3";
  }
  if (mimeType.includes("wav")) {
    return "wav";
  }
  return "webm";
}

function cadenceMilliseconds(chunkSeconds: number, overlapSeconds: number): number {
  return Math.max(1, (chunkSeconds - overlapSeconds) * 1000);
}

function effectiveOverlapSeconds(
  chunkIndex: number,
  startSeconds: number,
  endSeconds: number,
  configuredOverlapSeconds: number
): number {
  if (chunkIndex <= 1 || configuredOverlapSeconds <= 0) {
    return 0;
  }

  const durationSeconds = Math.max(0, endSeconds - startSeconds);
  if (durationSeconds <= configuredOverlapSeconds) {
    return 0;
  }

  return configuredOverlapSeconds;
}
