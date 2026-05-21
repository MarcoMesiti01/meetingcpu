type GetUserMedia = (constraints: MediaStreamConstraints) => Promise<MediaStream>;

export interface RecordedAudioChunk {
  chunkIndex: number;
  startSeconds: number;
  endSeconds: number;
  blob: Blob;
  mimeType: string;
  fileExtension: string;
  fileName: string;
}

export interface StartChunkedRecordingOptions {
  chunkSeconds?: number;
  onChunk: (chunk: RecordedAudioChunk) => void | Promise<void>;
}

const DEFAULT_CHUNK_SECONDS = 30;
const DEFAULT_MIME_TYPE = "audio/webm";

export class BrowserAudioRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private startInProgress = false;
  private chunkOptions: Required<StartChunkedRecordingOptions> | null = null;
  private nextChunkIndex = 1;

  constructor(
    private readonly getUserMedia: GetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices),
    private readonly MediaRecorderCtor: typeof MediaRecorder = MediaRecorder
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
      this.chunkOptions = {
        chunkSeconds: options.chunkSeconds ?? DEFAULT_CHUNK_SECONDS,
        onChunk: options.onChunk
      };

      const mediaRecorder = new this.MediaRecorderCtor(stream);
      this.mediaRecorder = mediaRecorder;
      mediaRecorder.ondataavailable = (event) => {
        void this.handleChunkedData(event.data).catch(() => undefined);
      };
      mediaRecorder.start(this.chunkOptions.chunkSeconds * 1000);
    } catch (error) {
      this.reset();
      throw error;
    } finally {
      this.startInProgress = false;
    }
  }

  async stop(): Promise<Blob> {
    if (!this.mediaRecorder) {
      throw new Error("Recording has not started.");
    }

    const recorder = this.mediaRecorder;
    return new Promise((resolve, reject) => {
      recorder.onstop = () => {
        const chunks = this.chunks;
        const type = chunks[0]?.type || DEFAULT_MIME_TYPE;
        this.reset();
        resolve(new Blob(chunks, { type }));
      };
      try {
        recorder.stop();
      } catch (error) {
        this.reset();
        reject(error);
      }
    });
  }

  private async handleChunkedData(blob: Blob) {
    if (blob.size <= 0 || !this.chunkOptions) {
      return;
    }

    const chunkIndex = this.nextChunkIndex;
    this.nextChunkIndex += 1;
    this.chunks.push(blob);

    const startSeconds = (chunkIndex - 1) * this.chunkOptions.chunkSeconds;
    const endSeconds = chunkIndex * this.chunkOptions.chunkSeconds;
    const mimeType = blob.type || DEFAULT_MIME_TYPE;
    const fileExtension = extensionForMimeType(mimeType);

    try {
      await this.chunkOptions.onChunk({
        chunkIndex,
        startSeconds,
        endSeconds,
        blob,
        mimeType,
        fileExtension,
        fileName: `chunk-${chunkIndex.toString().padStart(6, "0")}.${fileExtension}`
      });
    } catch (error) {
      this.reset();
    }
  }

  private reset() {
    if (this.mediaRecorder) {
      this.mediaRecorder.ondataavailable = null;
      this.mediaRecorder.onstop = null;
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.mediaRecorder = null;
    this.stream = null;
    this.chunks = [];
    this.chunkOptions = null;
    this.nextChunkIndex = 1;
  }
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
