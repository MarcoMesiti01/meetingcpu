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
  private nextChunkStartSeconds = 0;
  private chunkScheduleTimer: ReturnType<typeof setTimeout> | null = null;
  private activeChunkRecorders = new Set<ChunkRecorderState>();

  constructor(
    private readonly getUserMedia: GetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices),
    private readonly MediaRecorderCtor: typeof MediaRecorder = MediaRecorder,
    private readonly now: () => number = () => globalThis.performance?.now() ?? Date.now()
  ) {}

  async start(): Promise<void> {
    if (this.startInProgress || this.isRecording()) {
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
      this.nextChunkStartSeconds = 0;

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
    if (this.startInProgress || this.isRecording()) {
      throw new Error("Recording is already in progress.");
    }

    const timingOptions = validateChunkTimingOptions(options);
    this.startInProgress = true;

    try {
      const stream = await this.getUserMedia({ audio: true });
      this.stream = stream;
      this.chunks = [];
      this.nextChunkIndex = 1;
      this.pendingChunkCallbacks.clear();
      this.chunkCallbackError = null;
      this.nextChunkStartSeconds = 0;
      this.chunkOptions = {
        ...timingOptions,
        onChunk: options.onChunk
      };

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

      this.chunkRecordingStartedAtMs = this.now();
      this.startChunkRecorder(0);
      this.scheduleNextChunkRecorder();
    } catch (error) {
      this.reset();
      throw error;
    } finally {
      this.startInProgress = false;
    }
  }

  async stop(): Promise<Blob> {
    if (this.chunkOptions) {
      return this.stopChunkedRecording();
    }

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

  private emitChunkWindow(state: ChunkRecorderState, endSeconds: number) {
    if (!this.chunkOptions) {
      return;
    }

    if (state.chunks.length === 0) {
      return;
    }

    const chunkIndex = state.chunkIndex;
    const startSeconds = state.startSeconds;
    const mimeType = state.chunks[0]?.type || DEFAULT_MIME_TYPE;
    const blob = new Blob(state.chunks, { type: mimeType });
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

  private startChunkRecorder(startSeconds: number) {
    if (!this.stream || !this.chunkOptions) {
      return;
    }

    const recorder = new this.MediaRecorderCtor(this.stream);
    const state: ChunkRecorderState = {
      recorder,
      chunkIndex: this.nextChunkIndex,
      startSeconds,
      plannedEndSeconds: startSeconds + this.chunkOptions.chunkSeconds,
      chunks: [],
      stopTimer: null,
      stopPromise: null,
      stopped: false
    };
    this.nextChunkIndex += 1;
    this.activeChunkRecorders.add(state);

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        state.chunks.push(event.data);
      }
    };
    recorder.onstop = () => {
      state.stopped = true;
      this.clearChunkStopTimer(state);
      this.activeChunkRecorders.delete(state);
      this.emitChunkWindow(state, state.stopEndSeconds ?? state.plannedEndSeconds);
      state.resolveStop?.();
    };
    recorder.start();

    state.stopTimer = setTimeout(() => {
      void this.stopChunkRecorder(state, state.plannedEndSeconds).catch((error) => {
        this.chunkCallbackError = this.chunkCallbackError ?? error;
      });
    }, Math.round(this.chunkOptions.chunkSeconds * 1000));
  }

  private scheduleNextChunkRecorder() {
    if (!this.chunkOptions) {
      return;
    }

    const hopSeconds = cadenceSeconds(this.chunkOptions.chunkSeconds, this.chunkOptions.overlapSeconds);
    this.nextChunkStartSeconds += hopSeconds;
    this.chunkScheduleTimer = setTimeout(() => {
      this.chunkScheduleTimer = null;
      try {
        this.startChunkRecorder(this.nextChunkStartSeconds);
        this.scheduleNextChunkRecorder();
      } catch (error) {
        this.chunkCallbackError = this.chunkCallbackError ?? error;
        this.abortActiveRecording(error);
      }
    }, Math.round(hopSeconds * 1000));
  }

  private async stopChunkedRecording(): Promise<Blob> {
    this.clearChunkScheduleTimer();
    const elapsedSeconds = Math.max(0, (this.now() - this.chunkRecordingStartedAtMs) / 1000);
    const activeRecorders = [...this.activeChunkRecorders].sort((left, right) => left.startSeconds - right.startSeconds);

    try {
      const stopResults = await Promise.allSettled([
        this.stopFullRecorder(),
        ...activeRecorders.map((state) => {
          const endSeconds = Math.min(state.plannedEndSeconds, Math.max(state.startSeconds, elapsedSeconds));
          return this.stopChunkRecorder(state, endSeconds);
        })
      ]);
      await this.waitForPendingChunkCallbacks();
      const failedStop = stopResults.find((result) => result.status === "rejected");
      if (failedStop?.status === "rejected") {
        throw failedStop.reason;
      }
      if (this.chunkCallbackError) {
        throw this.chunkCallbackError;
      }
      const chunks = this.chunks;
      const type = chunks[0]?.type || DEFAULT_MIME_TYPE;
      this.reset();
      return new Blob(chunks, { type });
    } catch (error) {
      this.reset();
      throw normalizeError(error);
    }
  }

  private stopChunkRecorder(state: ChunkRecorderState, endSeconds: number): Promise<void> {
    if (state.stopped) {
      return state.stopPromise ?? Promise.resolve();
    }
    state.stopEndSeconds = endSeconds;
    if (!state.stopPromise) {
      state.stopPromise = new Promise((resolve, reject) => {
        state.resolveStop = resolve;
        state.rejectStop = reject;
      });
    }
    this.clearChunkStopTimer(state);
    try {
      state.recorder.stop();
    } catch (error) {
      state.stopped = true;
      this.activeChunkRecorders.delete(state);
      state.rejectStop?.(error);
    }
    return state.stopPromise;
  }

  private stopFullRecorder(): Promise<void> {
    const recorder = this.mediaRecorder;
    if (!recorder) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      recorder.onstop = () => resolve();
      try {
        recorder.stop();
      } catch (error) {
        reject(error);
      }
    });
  }

  private clearChunkScheduleTimer() {
    if (this.chunkScheduleTimer !== null) {
      clearTimeout(this.chunkScheduleTimer);
      this.chunkScheduleTimer = null;
    }
  }

  private clearChunkStopTimer(state: ChunkRecorderState) {
    if (state.stopTimer !== null) {
      clearTimeout(state.stopTimer);
      state.stopTimer = null;
    }
  }

  private abortActiveRecording(error: unknown) {
    this.chunkCallbackError = this.chunkCallbackError ?? error;
    this.clearChunkScheduleTimer();
    const activeRecorders = [...this.activeChunkRecorders];

    for (const state of activeRecorders) {
      void this.stopChunkRecorder(state, state.stopEndSeconds ?? state.plannedEndSeconds).catch((stopError) => {
        this.chunkCallbackError = this.chunkCallbackError ?? stopError;
      });
    }

    try {
      this.mediaRecorder?.stop();
    } catch (stopError) {
      this.chunkCallbackError = this.chunkCallbackError ?? stopError;
    }

    this.cleanupMedia();
  }

  private isRecording() {
    return this.mediaRecorder !== null || this.chunkOptions !== null;
  }

  private cleanupMedia() {
    if (this.mediaRecorder) {
      this.mediaRecorder.ondataavailable = null;
      this.mediaRecorder.onstop = null;
    }
    this.clearChunkScheduleTimer();
    this.activeChunkRecorders.forEach((state) => {
      this.clearChunkStopTimer(state);
      state.recorder.ondataavailable = null;
      state.recorder.onstop = null;
    });
    this.activeChunkRecorders.clear();
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
    this.nextChunkStartSeconds = 0;
  }
}

interface ChunkRecorderState {
  recorder: MediaRecorder;
  chunkIndex: number;
  startSeconds: number;
  plannedEndSeconds: number;
  chunks: Blob[];
  stopTimer: ReturnType<typeof setTimeout> | null;
  stopPromise: Promise<void> | null;
  resolveStop?: () => void;
  rejectStop?: (reason?: unknown) => void;
  stopEndSeconds?: number;
  stopped: boolean;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function validateChunkTimingOptions(options: StartChunkedRecordingOptions) {
  const chunkSeconds = options.chunkSeconds ?? DEFAULT_CHUNK_SECONDS;
  const overlapSeconds = options.overlapSeconds ?? DEFAULT_OVERLAP_SECONDS;

  if (chunkSeconds <= 0) {
    throw new Error("chunkSeconds must be greater than 0.");
  }
  if (overlapSeconds < 0) {
    throw new Error("overlapSeconds must be greater than or equal to 0.");
  }
  if (overlapSeconds >= chunkSeconds) {
    throw new Error("overlapSeconds must be less than chunkSeconds.");
  }

  return { chunkSeconds, overlapSeconds };
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
  return chunkSeconds - overlapSeconds;
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
