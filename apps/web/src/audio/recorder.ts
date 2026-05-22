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
  private lastSliceEndSeconds = 0;
  private sliceBuffer: RecordedAudioSlice[] = [];
  private recorderSliceSeconds = 0;
  private nextChunkStartSeconds = 0;
  private nextChunkEndSeconds = 0;

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
      this.lastSliceEndSeconds = 0;
      this.sliceBuffer = [];
      this.recorderSliceSeconds = 0;
      this.nextChunkStartSeconds = 0;
      this.nextChunkEndSeconds = 0;

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
      this.lastSliceEndSeconds = 0;
      this.sliceBuffer = [];
      this.nextChunkStartSeconds = 0;
      const chunkSeconds = options.chunkSeconds ?? DEFAULT_CHUNK_SECONDS;
      const overlapSeconds = options.overlapSeconds ?? (
        options.chunkSeconds === undefined ? DEFAULT_OVERLAP_SECONDS : 0
      );
      this.chunkOptions = {
        chunkSeconds,
        overlapSeconds,
        onChunk: options.onChunk
      };
      this.nextChunkEndSeconds = chunkSeconds;

      const mediaRecorder = new this.MediaRecorderCtor(stream);
      this.mediaRecorder = mediaRecorder;
      mediaRecorder.ondataavailable = (event) => {
        this.trackChunkedData(event.data);
      };
      this.chunkRecordingStartedAtMs = this.now();
      const recorderSliceMilliseconds = sliceMilliseconds(chunkSeconds, overlapSeconds);
      this.recorderSliceSeconds = recorderSliceMilliseconds / 1000;
      mediaRecorder.start(recorderSliceMilliseconds);
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
            this.flushFinalChunkWindow();
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
            this.flushFinalChunkWindow();
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

    this.chunks.push(blob);
    const sliceStartSeconds = this.lastSliceEndSeconds;
    const elapsedSeconds = Math.max(0, (this.now() - this.chunkRecordingStartedAtMs) / 1000);
    const sliceEndSeconds = Math.max(sliceStartSeconds + this.recorderSliceSeconds, elapsedSeconds);
    this.lastSliceEndSeconds = sliceEndSeconds;
    this.sliceBuffer.push({ startSeconds: sliceStartSeconds, endSeconds: sliceEndSeconds, blob });

    this.flushCompleteChunkWindows();
  }

  private flushCompleteChunkWindows() {
    while (this.chunkOptions && this.lastSliceEndSeconds >= this.nextChunkEndSeconds) {
      this.emitChunkWindow(this.nextChunkStartSeconds, this.nextChunkEndSeconds);
      this.advanceChunkWindow();
    }
  }

  private flushFinalChunkWindow() {
    if (!this.chunkOptions || this.sliceBuffer.length === 0 || this.lastSliceEndSeconds <= this.nextChunkStartSeconds) {
      return;
    }
    if (
      this.nextChunkIndex > 1 &&
      this.lastSliceEndSeconds <= this.nextChunkStartSeconds + this.chunkOptions.overlapSeconds
    ) {
      return;
    }

    this.emitChunkWindow(this.nextChunkStartSeconds, this.lastSliceEndSeconds);
    this.advanceChunkWindow();
  }

  private emitChunkWindow(startSeconds: number, endSeconds: number) {
    if (!this.chunkOptions) {
      return;
    }

    const windowSlices = this.sliceBuffer.filter((slice) => (
      slice.endSeconds > startSeconds && slice.startSeconds < endSeconds
    ));
    if (windowSlices.length === 0) {
      return;
    }

    const chunkIndex = this.nextChunkIndex;
    this.nextChunkIndex += 1;
    const blobParts = windowSlices.map((slice) => slice.blob);
    const mimeType = windowSlices[0]?.blob.type || DEFAULT_MIME_TYPE;
    const blob = new Blob(blobParts, { type: mimeType });
    const fileExtension = extensionForMimeType(mimeType);
    const overlapSeconds = effectiveOverlapSeconds(
      chunkIndex,
      startSeconds,
      endSeconds,
      this.chunkOptions.overlapSeconds
    );

    const pending = Promise.resolve(this.chunkOptions.onChunk({
      chunkIndex,
      startSeconds,
      endSeconds,
      overlapSeconds,
      blob,
      mimeType,
      fileExtension,
      fileName: `chunk-${chunkIndex.toString().padStart(6, "0")}.${fileExtension}`
    })).catch((error) => {
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

  private advanceChunkWindow() {
    if (!this.chunkOptions) {
      return;
    }

    const hopSeconds = cadenceSeconds(this.chunkOptions.chunkSeconds, this.chunkOptions.overlapSeconds);
    this.nextChunkStartSeconds += hopSeconds;
    this.nextChunkEndSeconds += hopSeconds;
    this.sliceBuffer = this.sliceBuffer.filter((slice) => slice.endSeconds > this.nextChunkStartSeconds);
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
    this.lastSliceEndSeconds = 0;
    this.sliceBuffer = [];
    this.recorderSliceSeconds = 0;
    this.nextChunkStartSeconds = 0;
    this.nextChunkEndSeconds = 0;
  }
}

interface RecordedAudioSlice {
  startSeconds: number;
  endSeconds: number;
  blob: Blob;
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

function cadenceSeconds(chunkSeconds: number, overlapSeconds: number): number {
  return Math.max(0.001, chunkSeconds - overlapSeconds);
}

function sliceMilliseconds(chunkSeconds: number, overlapSeconds: number): number {
  const chunkMilliseconds = Math.max(1, Math.round(chunkSeconds * 1000));
  const cadenceMilliseconds = Math.max(1, Math.round(cadenceSeconds(chunkSeconds, overlapSeconds) * 1000));
  return gcd(chunkMilliseconds, cadenceMilliseconds);
}

function gcd(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b > 0) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return Math.max(1, a);
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
