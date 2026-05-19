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
    this.stream = await this.getUserMedia({ audio: true });
    this.chunks = [];
    this.mediaRecorder = new this.MediaRecorderCtor(this.stream);
    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.chunks.push(event.data);
      } else if (this.chunks.length === 0) {
        this.chunks.push(event.data);
      }
    };
    this.mediaRecorder.start();
  }

  async stop(): Promise<Blob> {
    if (!this.mediaRecorder) {
      throw new Error("Recording has not started.");
    }

    const recorder = this.mediaRecorder;
    return new Promise((resolve) => {
      recorder.onstop = () => {
        this.stream?.getTracks().forEach((track) => track.stop());
        const type = this.chunks[0]?.type || "audio/webm";
        resolve(new Blob(this.chunks, { type }));
      };
      recorder.stop();
    });
  }
}
