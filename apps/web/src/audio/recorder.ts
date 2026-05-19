type GetUserMedia = (constraints: MediaStreamConstraints) => Promise<MediaStream>;

export class BrowserAudioRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;

  constructor(
    private readonly getUserMedia: GetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices),
    private readonly MediaRecorderCtor: typeof MediaRecorder = MediaRecorder
  ) {}

  async start(): Promise<void> {
    if (this.mediaRecorder) {
      throw new Error("Recording is already in progress.");
    }

    const stream = await this.getUserMedia({ audio: true });
    this.stream = stream;
    this.chunks = [];

    try {
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
        const type = chunks[0]?.type || "audio/webm";
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

  private reset() {
    if (this.mediaRecorder) {
      this.mediaRecorder.ondataavailable = null;
      this.mediaRecorder.onstop = null;
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.mediaRecorder = null;
    this.stream = null;
    this.chunks = [];
  }
}
