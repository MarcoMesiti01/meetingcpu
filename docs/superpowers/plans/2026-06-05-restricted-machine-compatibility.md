# Restricted Machine Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make live and uploaded transcription run reliably on corporate-restricted Windows machines without requiring global ffmpeg/PATH configuration.

**Architecture:** Uploaded files are decoded and chunked in the browser, encoded as WAV chunks, and sent through the existing chunk-session APIs. Server ffmpeg stays behind an explicit fallback flag. Runtime hardening adds configurable storage/ports/origins, opt-in diarization, and preflight checks that report blocked capabilities clearly.

**Tech Stack:** React 19, Vite, TypeScript, Express, Vitest, Python FastAPI, faster-whisper, pytest.

---

## File Structure

- Create: `apps/web/src/audio/uploadChunker.ts` — browser-side uploaded-file decode, chunk timing, and WAV encoding.
- Create: `apps/web/src/audio/uploadChunker.test.ts` — unit tests for upload chunking and WAV encoding.
- Modify: `apps/web/src/App.tsx` — route uploaded files through chunk sessions instead of legacy `/api/transcriptions`.
- Modify: `apps/web/src/App.test.tsx` — assert upload flow uses session chunk APIs and handles decode failures.
- Modify: `apps/web/src/api/client.ts` — allow upload session metadata and optional preflight endpoint.
- Modify: `apps/web/src/api/client.test.ts` — API client coverage for new request fields/preflight.
- Create: `apps/web/src/preflight/browserCapabilities.ts` — browser-side capability checks for upload, microphone, and events.
- Create: `apps/web/src/preflight/browserCapabilities.test.ts` — browser capability unit tests.
- Modify: `apps/server/src/routes.ts` — accept `sourceType=upload` sessions, gate ffmpeg fallback, add preflight route.
- Modify: `apps/server/src/routes.test.ts` — server tests for upload source sessions, fallback gating, and preflight.
- Modify: `apps/server/src/config.ts` — configurable ports, storage roots, temp dir, origins, fallback flags.
- Modify: `apps/server/src/config.test.ts` — config tests.
- Modify: `apps/server/src/app.ts` — configurable allowed origins.
- Modify: `scripts/dev.mjs` — use configured ports and service URL.
- Modify: `apps/web/package.json` — parameterize Vite host/port command where needed.
- Modify: `apps/web/vite.config.ts` — use configured API proxy port.
- Modify: `services/whisper/app/main.py` — default diarization request behavior to disabled unless enabled.
- Modify: `services/whisper/app/transcriber.py` — support model cache dir env and no eager diarizer requirement.
- Modify: `services/whisper/app/diarization.py` — keep ffmpeg runtime setup optional and explicit.
- Modify: `services/whisper/tests/test_api.py` — default diarization-off API tests.
- Modify: `services/whisper/tests/test_transcriber.py` — transcriber diarization default tests.
- Modify: `README.md` — restricted-machine setup, upload behavior, storage, ports, and optional features.

Do not commit during implementation unless the user explicitly requests it.

---

### Task 1: Browser Upload Chunker

**Files:**
- Create: `apps/web/src/audio/uploadChunker.ts`
- Create: `apps/web/src/audio/uploadChunker.test.ts`

- [ ] **Step 1: Write failing upload chunker tests**

Create `apps/web/src/audio/uploadChunker.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { BrowserUploadChunker } from "./uploadChunker";

describe("BrowserUploadChunker", () => {
  it("decodes an uploaded file into 30-second wav chunks with overlap metadata", async () => {
    const audioBuffer = createAudioBuffer({ durationSeconds: 65, sampleRate: 8000, channels: 1 });
    const AudioContextCtor = createAudioContext(audioBuffer);
    const chunker = new BrowserUploadChunker(AudioContextCtor);
    const file = new File([new Uint8Array([1, 2, 3])], "meeting.mp3", { type: "audio/mpeg" });

    const chunks = await chunker.chunkFile(file, { chunkSeconds: 30, overlapSeconds: 5 });

    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => ({
      chunkIndex: chunk.chunkIndex,
      startSeconds: chunk.startSeconds,
      endSeconds: chunk.endSeconds,
      overlapSeconds: chunk.overlapSeconds,
      mimeType: chunk.mimeType,
      fileName: chunk.fileName
    }))).toEqual([
      { chunkIndex: 1, startSeconds: 0, endSeconds: 30, overlapSeconds: 0, mimeType: "audio/wav", fileName: "chunk-000001.wav" },
      { chunkIndex: 2, startSeconds: 25, endSeconds: 55, overlapSeconds: 5, mimeType: "audio/wav", fileName: "chunk-000002.wav" },
      { chunkIndex: 3, startSeconds: 50, endSeconds: 65, overlapSeconds: 5, mimeType: "audio/wav", fileName: "chunk-000003.wav" }
    ]);
    expect(chunks[0].blob.type).toBe("audio/wav");
    expect(await readHeader(chunks[0].blob)).toBe("RIFF");
  });

  it("reports unsupported browser decoding with a clear error", async () => {
    const AudioContextCtor = createRejectingAudioContext(new DOMException("unsupported", "EncodingError"));
    const chunker = new BrowserUploadChunker(AudioContextCtor);
    const file = new File([new Uint8Array([1])], "meeting.xyz", { type: "application/octet-stream" });

    await expect(chunker.chunkFile(file)).rejects.toThrow(
      "This audio format is not supported by your browser on this machine."
    );
  });
});

function createAudioBuffer(input: { durationSeconds: number; sampleRate: number; channels: number }): AudioBuffer {
  const length = input.durationSeconds * input.sampleRate;
  return {
    duration: input.durationSeconds,
    length,
    numberOfChannels: input.channels,
    sampleRate: input.sampleRate,
    getChannelData: () => {
      const data = new Float32Array(length);
      data.fill(0.25);
      return data;
    }
  } as AudioBuffer;
}

function createAudioContext(audioBuffer: AudioBuffer) {
  return class FakeAudioContext {
    decodeAudioData = vi.fn().mockResolvedValue(audioBuffer);
    close = vi.fn().mockResolvedValue(undefined);
  } as unknown as typeof AudioContext;
}

function createRejectingAudioContext(error: Error) {
  return class FakeAudioContext {
    decodeAudioData = vi.fn().mockRejectedValue(error);
    close = vi.fn().mockResolvedValue(undefined);
  } as unknown as typeof AudioContext;
}

async function readHeader(blob: Blob): Promise<string> {
  return new TextDecoder().decode(await blob.slice(0, 4).arrayBuffer());
}
```

- [ ] **Step 2: Run test and verify RED**

Run: `npm --workspace @meetingcpu/web test -- uploadChunker.test.ts`

Expected: FAIL because `./uploadChunker` does not exist.

- [ ] **Step 3: Implement browser upload chunker**

Create `apps/web/src/audio/uploadChunker.ts`:

```typescript
export interface UploadedAudioChunk {
  chunkIndex: number;
  startSeconds: number;
  endSeconds: number;
  overlapSeconds: number;
  blob: Blob;
  mimeType: string;
  fileExtension: string;
  fileName: string;
}

export interface UploadChunkerOptions {
  chunkSeconds?: number;
  overlapSeconds?: number;
}

const DEFAULT_CHUNK_SECONDS = 30;
const DEFAULT_OVERLAP_SECONDS = 5;
const WAV_MIME_TYPE = "audio/wav";

export class BrowserUploadChunker {
  constructor(private readonly AudioContextCtor: typeof AudioContext = AudioContext) {}

  async chunkFile(file: File, options: UploadChunkerOptions = {}): Promise<UploadedAudioChunk[]> {
    const timing = validateOptions(options);
    const context = new this.AudioContextCtor();
    try {
      const decoded = await decodeFile(context, file);
      return chunksFromBuffer(decoded, timing.chunkSeconds, timing.overlapSeconds);
    } finally {
      await context.close().catch(() => undefined);
    }
  }
}

async function decodeFile(context: AudioContext, file: File): Promise<AudioBuffer> {
  try {
    return await context.decodeAudioData(await file.arrayBuffer());
  } catch (error) {
    throw new Error(
      `This audio format is not supported by your browser on this machine. Try WAV, MP3, M4A, or WebM, or enable the optional server ffmpeg fallback. ${error instanceof Error ? error.message : ""}`.trim()
    );
  }
}

function chunksFromBuffer(audioBuffer: AudioBuffer, chunkSeconds: number, overlapSeconds: number): UploadedAudioChunk[] {
  const chunks: UploadedAudioChunk[] = [];
  const hopSeconds = chunkSeconds - overlapSeconds;
  for (let startSeconds = 0, chunkIndex = 1; startSeconds < audioBuffer.duration; startSeconds += hopSeconds, chunkIndex += 1) {
    const endSeconds = Math.min(audioBuffer.duration, startSeconds + chunkSeconds);
    chunks.push({
      chunkIndex,
      startSeconds,
      endSeconds,
      overlapSeconds: chunkIndex === 1 ? 0 : Math.min(overlapSeconds, Math.max(0, endSeconds - startSeconds)),
      blob: encodeWav(audioBuffer, startSeconds, endSeconds),
      mimeType: WAV_MIME_TYPE,
      fileExtension: "wav",
      fileName: `chunk-${chunkIndex.toString().padStart(6, "0")}.wav`
    });
  }
  return chunks;
}

function encodeWav(audioBuffer: AudioBuffer, startSeconds: number, endSeconds: number): Blob {
  const sampleRate = audioBuffer.sampleRate;
  const startFrame = Math.floor(startSeconds * sampleRate);
  const endFrame = Math.min(audioBuffer.length, Math.ceil(endSeconds * sampleRate));
  const channelCount = audioBuffer.numberOfChannels;
  const frameCount = Math.max(0, endFrame - startFrame);
  const bytesPerSample = 2;
  const dataSize = frameCount * channelCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  const channels = Array.from({ length: channelCount }, (_value, channelIndex) => audioBuffer.getChannelData(channelIndex));
  for (let frame = startFrame; frame < endFrame; frame += 1) {
    for (const channel of channels) {
      const sample = Math.max(-1, Math.min(1, channel[frame] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }
  return new Blob([buffer], { type: WAV_MIME_TYPE });
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function validateOptions(options: UploadChunkerOptions): { chunkSeconds: number; overlapSeconds: number } {
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
```

- [ ] **Step 4: Run test and verify GREEN**

Run: `npm --workspace @meetingcpu/web test -- uploadChunker.test.ts`

Expected: PASS.

- [ ] **Step 5: Review checkpoint**

Run: `git diff -- apps/web/src/audio/uploadChunker.ts apps/web/src/audio/uploadChunker.test.ts`

Expected: Only upload chunker files changed. Do not commit unless requested.

---

### Task 2: Upload UI Uses Chunk Sessions

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/main.tsx`

- [ ] **Step 1: Write failing App upload-flow test**

Add to `apps/web/src/App.test.tsx`:

```typescript
it("transcribes uploaded files through browser chunks and chunk sessions without legacy upload transcription", async () => {
  const user = userEvent.setup();
  const api = createApi({
    createSession: vi.fn().mockResolvedValue({
      sessionId: "upload-session",
      sessionPath: "C:\\recordings\\upload-session",
      inProgressTranscriptPath: "C:\\recordings\\upload-session\\transcript.in-progress.txt"
    }),
    uploadSessionChunk: vi.fn().mockResolvedValue({ sessionId: "upload-session", chunkIndex: 1, status: "queued" }),
    finalizeSession: vi.fn().mockResolvedValue({
      sessionId: "upload-session",
      transcriptPath: "C:\\recordings\\upload-session\\transcript.txt",
      transcriptJsonPath: "C:\\recordings\\upload-session\\transcript.json",
      partial: false
    })
  });
  const uploadChunker = {
    chunkFile: vi.fn().mockResolvedValue([
      createChunk({ fileName: "chunk-000001.wav", mimeType: "audio/wav", fileExtension: "wav" })
    ])
  };

  render(<App api={api} recorder={createRecorder()} uploadChunker={uploadChunker} />);

  await waitFor(() => expect(screen.getByLabelText("Model")).toHaveValue("small"));
  await user.upload(screen.getByLabelText("Choose file"), new File(["audio"], "meeting.mp3", { type: "audio/mpeg" }));

  await waitFor(() => expect(uploadChunker.chunkFile).toHaveBeenCalledWith(expect.any(File)));
  expect(api.createSession).toHaveBeenCalledWith({
    title: "Untitled meeting",
    modelId: "small",
    sourceType: "upload",
    diarization: false
  });
  expect(api.uploadSessionChunk).toHaveBeenCalledWith(expect.objectContaining({
    sessionId: "upload-session",
    sourceType: "upload",
    fileName: "chunk-000001.wav",
    mimeType: "audio/wav"
  }));
  expect(api.finalizeSession).toHaveBeenCalledWith("upload-session");
  expect(api.transcribeAudio).not.toHaveBeenCalled();
});
```

Also add this test:

```typescript
it("shows a clear upload decode error before creating a session", async () => {
  const user = userEvent.setup();
  const api = createApi();
  const uploadChunker = {
    chunkFile: vi.fn().mockRejectedValue(new Error("This audio format is not supported by your browser on this machine."))
  };

  render(<App api={api} recorder={createRecorder()} uploadChunker={uploadChunker} />);

  await waitFor(() => expect(screen.getByLabelText("Model")).toHaveValue("small"));
  await user.upload(screen.getByLabelText("Choose file"), new File(["bad"], "meeting.xyz"));

  expect(await screen.findByRole("alert")).toHaveTextContent("This audio format is not supported");
  expect(api.createSession).not.toHaveBeenCalled();
  expect(api.transcribeAudio).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run App test and verify RED**

Run: `npm --workspace @meetingcpu/web test -- App.test.tsx`

Expected: FAIL because `App` does not accept `uploadChunker` and uploads still call `transcribeAudio`.

- [ ] **Step 3: Modify App props and upload flow**

In `apps/web/src/App.tsx`, add:

```typescript
import type { UploadedAudioChunk } from "./audio/uploadChunker";

export interface AppUploadChunker {
  chunkFile(file: File): Promise<UploadedAudioChunk[]>;
}
```

Update props:

```typescript
interface AppProps {
  api: AppApi;
  recorder: AppRecorder;
  uploadChunker: AppUploadChunker;
}
```

Replace `handleUpload` internals with:

```typescript
async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;

  clearResult();
  setStatus("transcribing");
  setError("");

  try {
    const chunks = await uploadChunker.chunkFile(file);
    const created = await api.createSession({
      title: title.trim() || "Untitled meeting",
      modelId,
      sourceType: "upload",
      diarization: false
    });
    setSessionPaths({
      sessionPath: created.sessionPath,
      inProgressTranscriptPath: created.inProgressTranscriptPath
    });
    for (const chunk of chunks) {
      await uploadPreparedChunk(created.sessionId, chunk);
      setSavedChunkCount((count) => Math.max(count, chunk.chunkIndex));
    }
    const finalized = await api.finalizeSession(created.sessionId);
    applyFinalizedSession(finalized);
    setSessionId("");
    setStatus(finalized.partial ? "error" : "complete");
  } catch (uploadError) {
    setError(getErrorMessage(uploadError, "Could not transcribe upload."));
    setStatus("error");
    setSessionId("");
  }
}
```

Add helper:

```typescript
async function uploadPreparedChunk(activeSessionId: string, chunk: UploadedAudioChunk) {
  await api.uploadSessionChunk({
    sessionId: activeSessionId,
    audio: chunk.blob,
    fileName: chunk.fileName,
    chunkIndex: chunk.chunkIndex,
    startSeconds: chunk.startSeconds,
    endSeconds: chunk.endSeconds,
    overlapSeconds: chunk.overlapSeconds,
    modelId,
    sourceType: "upload",
    mimeType: chunk.mimeType
  });
}
```

Update `CreateSessionInput` type usage in `apps/web/src/api/client.ts` as covered by Task 3.

- [ ] **Step 4: Wire default upload chunker**

In `apps/web/src/main.tsx`, add:

```typescript
import { BrowserUploadChunker } from "./audio/uploadChunker";
```

Render:

```tsx
<App api={createApiClient()} recorder={new BrowserAudioRecorder()} uploadChunker={new BrowserUploadChunker()} />
```

- [ ] **Step 5: Run App test and verify GREEN**

Run: `npm --workspace @meetingcpu/web test -- App.test.tsx`

Expected: PASS after updating any local test helpers to include `uploadChunker`.

- [ ] **Step 6: Review checkpoint**

Run: `git diff -- apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/main.tsx`

Expected: Upload UI uses session chunk APIs. Do not commit unless requested.

---

### Task 3: API Types and Upload Session Metadata

**Files:**
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/api/client.test.ts`
- Modify: `apps/server/src/routes.ts`
- Modify: `apps/server/src/routes.test.ts`

- [ ] **Step 1: Write failing API client test**

In `apps/web/src/api/client.test.ts`, update the create session test to include `sourceType`:

```typescript
await expect(
  client.createSession({ title: "Planning", modelId: "small", language: "en", sourceType: "upload", diarization: false })
).resolves.toMatchObject({ sessionId: "session-1" });

expect(fetchMock).toHaveBeenCalledWith("/api/sessions", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "Planning", modelId: "small", language: "en", sourceType: "upload", diarization: false })
});
```

- [ ] **Step 2: Write failing server route test**

Add to `apps/server/src/routes.test.ts`:

```typescript
it("creates upload chunk sessions without resolving ffmpeg", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
  const resolveFfmpegPath = vi.fn();
  const app = createApp({
    dataRoot,
    transcriptionClient: fakeTranscriptionClient(),
    ffmpegChunks: { resolveFfmpegPath }
  });

  const response = await request(app)
    .post("/api/sessions")
    .send({ title: "Uploaded meeting", modelId: "small", sourceType: "upload", diarization: false })
    .expect(201);

  expect(resolveFfmpegPath).not.toHaveBeenCalled();
  const metadata = JSON.parse(await readFile(join(dataRoot, "sessions", response.body.sessionId, "metadata.json"), "utf8"));
  expect(metadata).toMatchObject({
    sourceType: "upload",
    modelId: "small"
  });
});
```

- [ ] **Step 3: Run tests and verify RED**

Run: `npm --workspace @meetingcpu/web test -- client.test.ts`

Expected: FAIL because `CreateSessionInput` lacks `sourceType`.

Run: `npm --workspace @meetingcpu/server test -- routes.test.ts`

Expected: FAIL because `/api/sessions` ignores `sourceType`.

- [ ] **Step 4: Implement client and server metadata**

In `apps/web/src/api/client.ts`, update:

```typescript
export interface CreateSessionInput {
  title: string;
  modelId: string;
  language?: string;
  sourceType?: "microphone" | "upload";
  diarization?: boolean;
}
```

In `apps/server/src/routes.ts`, change `createChunkSession` call inside `POST /sessions`:

```typescript
const sourceType = parseSourceType(request.body.sourceType);
const session = await createChunkSession({
  dataRoot: dependencies.dataRoot,
  title: String(request.body.title ?? "local meeting"),
  modelId: modelResult.value,
  sourceType
});
```

- [ ] **Step 5: Run tests and verify GREEN**

Run: `npm --workspace @meetingcpu/web test -- client.test.ts`

Expected: PASS.

Run: `npm --workspace @meetingcpu/server test -- routes.test.ts`

Expected: PASS.

- [ ] **Step 6: Review checkpoint**

Run: `git diff -- apps/web/src/api/client.ts apps/web/src/api/client.test.ts apps/server/src/routes.ts apps/server/src/routes.test.ts`

Expected: Session metadata support only. Do not commit unless requested.

---

### Task 4: Gate Server FFmpeg Upload Fallback

**Files:**
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/config.test.ts`
- Modify: `apps/server/src/routes.ts`
- Modify: `apps/server/src/routes.test.ts`

- [ ] **Step 1: Write failing config test for fallback flag**

Add to `apps/server/src/config.test.ts`:

```typescript
it("keeps server ffmpeg upload fallback disabled by default", () => {
  expect(loadConfig({}).enableFfmpegUploadFallback).toBe(false);
});

it("enables server ffmpeg upload fallback explicitly", () => {
  expect(loadConfig({ MEETINGCPU_ENABLE_FFMPEG_UPLOAD_FALLBACK: "true" }).enableFfmpegUploadFallback).toBe(true);
});
```

- [ ] **Step 2: Write failing route test for gated legacy upload**

In `apps/server/src/routes.test.ts`, update the existing unavailable-ffmpeg upload test to expect a disabled fallback message when fallback is off:

```typescript
const response = await request(app)
  .post("/api/transcriptions")
  .field("sourceType", "upload")
  .field("modelId", "small")
  .attach("audio", Buffer.from("audio"), "meeting.mp3")
  .expect(501);

expect(response.body).toEqual({
  code: "UPLOAD_FALLBACK_DISABLED",
  message: "Server-side upload transcription is disabled. Uploads use browser chunking by default."
});
```

Add a second test:

```typescript
it("uses optional ffmpeg upload fallback only when explicitly enabled", async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), "meetingcpu-"));
  const splitAudioIntoChunks = vi.fn(async ({ outputDirectory }: { outputDirectory: string }) => {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(join(outputDirectory, "chunk-000000.webm"), "upload chunk");
    return [{ index: 0, path: join(outputDirectory, "chunk-000000.webm"), startSeconds: 0, endSeconds: 1, durationSeconds: 1 }];
  });
  const app = createApp({
    dataRoot,
    transcriptionClient: fakeTranscriptionClient(),
    enableFfmpegUploadFallback: true,
    ffmpegChunks: {
      resolveFfmpegPath: vi.fn().mockResolvedValue("C:\\bin\\ffmpeg.exe"),
      splitAudioIntoChunks
    }
  });

  await request(app)
    .post("/api/transcriptions")
    .field("sourceType", "upload")
    .field("modelId", "small")
    .attach("audio", Buffer.from("audio"), "meeting.webm")
    .expect(201);

  expect(splitAudioIntoChunks).toHaveBeenCalled();
});
```

- [ ] **Step 3: Run tests and verify RED**

Run: `npm --workspace @meetingcpu/server test -- config.test.ts routes.test.ts`

Expected: FAIL because config and route dependency do not include fallback flag.

- [ ] **Step 4: Implement fallback flag**

In `apps/server/src/config.ts`, extend:

```typescript
export interface ServerConfig {
  host: string;
  port: number;
  dataRoot: string;
  transcriptionServiceUrl: string;
  enableFfmpegUploadFallback: boolean;
}
```

Add to `loadConfig` return:

```typescript
enableFfmpegUploadFallback: env.MEETINGCPU_ENABLE_FFMPEG_UPLOAD_FALLBACK === "true"
```

In `apps/server/src/routes.ts`, add to `RouteDependencies`:

```typescript
enableFfmpegUploadFallback?: boolean;
```

Add constant:

```typescript
const UPLOAD_FALLBACK_DISABLED = {
  code: "UPLOAD_FALLBACK_DISABLED",
  message: "Server-side upload transcription is disabled. Uploads use browser chunking by default."
};
```

Before `handleUploadTranscription`:

```typescript
if (sourceType === "upload" && dependencies.enableFfmpegUploadFallback !== true) {
  await cleanupUpload(request.file);
  response.status(501).json(UPLOAD_FALLBACK_DISABLED);
  return;
}
```

Pass config from `apps/server/src/index.ts`:

```typescript
enableFfmpegUploadFallback: config.enableFfmpegUploadFallback
```

- [ ] **Step 5: Run tests and verify GREEN**

Run: `npm --workspace @meetingcpu/server test -- config.test.ts routes.test.ts`

Expected: PASS.

- [ ] **Step 6: Review checkpoint**

Run: `git diff -- apps/server/src/config.ts apps/server/src/config.test.ts apps/server/src/routes.ts apps/server/src/routes.test.ts apps/server/src/index.ts`

Expected: Legacy ffmpeg upload is opt-in. Do not commit unless requested.

---

### Task 5: Configurable Storage, Ports, and Origins

**Files:**
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/config.test.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/routes.test.ts`
- Modify: `scripts/dev.mjs`
- Modify: `apps/web/vite.config.ts`
- Modify: `apps/web/package.json`

- [ ] **Step 1: Write failing config tests**

Add to `apps/server/src/config.test.ts`:

```typescript
it("uses user-writable Windows app data when data dir is not configured", () => {
  const config = loadConfig({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" });

  expect(config.dataRoot).toBe("C:\\Users\\me\\AppData\\Local\\meetingcpu\\data");
});

it("supports explicit storage and port overrides", () => {
  const config = loadConfig({
    MEETINGCPU_DATA_DIR: "D:\\meeting-data",
    MEETINGCPU_TMP_DIR: "D:\\meeting-temp",
    MEETINGCPU_MODELS_DIR: "D:\\meeting-models",
    MEETINGCPU_SERVER_PORT: "6180",
    MEETINGCPU_WHISPER_PORT: "6181",
    MEETINGCPU_ALLOWED_ORIGINS: "http://127.0.0.1:9999,http://localhost:9999"
  });

  expect(config.dataRoot).toBe("D:\\meeting-data");
  expect(config.tmpRoot).toBe("D:\\meeting-temp");
  expect(config.modelsRoot).toBe("D:\\meeting-models");
  expect(config.port).toBe(6180);
  expect(config.transcriptionServiceUrl).toBe("http://127.0.0.1:6181");
  expect(config.allowedOrigins).toEqual(["http://127.0.0.1:9999", "http://localhost:9999"]);
});
```

- [ ] **Step 2: Write failing CORS origin test**

Add to `apps/server/src/routes.test.ts` or `apps/server/src/app.test.ts`:

```typescript
it("allows configured local browser origins", async () => {
  const app = createApp({
    dataRoot: await mkdtemp(join(tmpdir(), "meetingcpu-")),
    transcriptionClient: fakeTranscriptionClient(),
    allowedOrigins: ["http://127.0.0.1:9999"]
  });

  await request(app)
    .get("/api/health")
    .set("Origin", "http://127.0.0.1:9999")
    .expect(200)
    .expect("Access-Control-Allow-Origin", "http://127.0.0.1:9999");
});
```

- [ ] **Step 3: Run tests and verify RED**

Run: `npm --workspace @meetingcpu/server test -- config.test.ts routes.test.ts`

Expected: FAIL because new config fields and allowed origins are absent.

- [ ] **Step 4: Implement config**

In `apps/server/src/config.ts`, update `ServerConfig`:

```typescript
export interface ServerConfig {
  host: string;
  port: number;
  dataRoot: string;
  tmpRoot: string;
  modelsRoot: string;
  transcriptionServiceUrl: string;
  whisperPort: number;
  allowedOrigins: string[];
  enableFfmpegUploadFallback: boolean;
}
```

Add helpers:

```typescript
function defaultAppDataRoot(env: NodeJS.ProcessEnv): string {
  if (env.LOCALAPPDATA) {
    return resolve(env.LOCALAPPDATA, "meetingcpu");
  }
  return resolve(".meetingcpu");
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function listFromEnv(value: string | undefined): string[] {
  return value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
}
```

Return:

```typescript
const appDataRoot = defaultAppDataRoot(env);
const whisperPort = numberFromEnv(env.MEETINGCPU_WHISPER_PORT, 8765);
return {
  host: "127.0.0.1",
  port: numberFromEnv(env.MEETINGCPU_SERVER_PORT ?? env.PORT, 5174),
  dataRoot: resolve(env.MEETINGCPU_DATA_DIR ?? appDataRoot, env.MEETINGCPU_DATA_DIR ? "" : "data"),
  tmpRoot: resolve(env.MEETINGCPU_TMP_DIR ?? appDataRoot, env.MEETINGCPU_TMP_DIR ? "" : "tmp"),
  modelsRoot: resolve(env.MEETINGCPU_MODELS_DIR ?? "models"),
  whisperPort,
  transcriptionServiceUrl: env.TRANSCRIPTION_SERVICE_URL ?? `http://127.0.0.1:${whisperPort}`,
  allowedOrigins: listFromEnv(env.MEETINGCPU_ALLOWED_ORIGINS),
  enableFfmpegUploadFallback: env.MEETINGCPU_ENABLE_FFMPEG_UPLOAD_FALLBACK === "true"
};
```

- [ ] **Step 5: Implement allowed origins**

In `apps/server/src/routes.ts`, add to `RouteDependencies`:

```typescript
allowedOrigins?: string[];
```

In `apps/server/src/app.ts`, use:

```typescript
app.use(cors({ origin: corsOrigin(dependencies.allowedOrigins ?? []) }));
```

Replace `corsOrigin` with:

```typescript
function corsOrigin(allowedOrigins: string[]) {
  return (origin: string | undefined, callback: (error: Error | null, origin?: boolean | string) => void): void => {
    if (!origin) {
      callback(null, true);
      return;
    }
    callback(null, isAllowedLocalOrigin(origin) || allowedOrigins.includes(origin) ? origin : false);
  };
}
```

Pass from `apps/server/src/index.ts`:

```typescript
allowedOrigins: config.allowedOrigins
```

- [ ] **Step 6: Parameterize dev ports**

In `scripts/dev.mjs`, compute:

```javascript
const serverPort = process.env.MEETINGCPU_SERVER_PORT ?? process.env.PORT ?? "5174";
const webPort = process.env.MEETINGCPU_WEB_PORT ?? "5173";
const whisperPort = process.env.MEETINGCPU_WHISPER_PORT ?? "8765";
```

Use:

```javascript
command: `${quote(python)} -m uvicorn app.main:app --app-dir services/whisper --host 127.0.0.1 --port ${whisperPort}`,
env: { TRANSCRIPTION_SERVICE_URL: `http://127.0.0.1:${whisperPort}`, MEETINGCPU_SERVER_PORT: serverPort }
```

For web:

```javascript
command: `npm --workspace @meetingcpu/web run dev -- --host 127.0.0.1 --port ${webPort}`,
env: { MEETINGCPU_SERVER_PORT: serverPort }
```

In `apps/web/vite.config.ts`, set proxy target:

```typescript
const apiPort = process.env.MEETINGCPU_SERVER_PORT ?? process.env.PORT ?? "5174";
```

Use:

```typescript
proxy: {
  "/api": `http://127.0.0.1:${apiPort}`
}
```

- [ ] **Step 7: Run tests and verify GREEN**

Run: `npm --workspace @meetingcpu/server test -- config.test.ts routes.test.ts`

Expected: PASS.

Run: `npm run test:scripts`

Expected: PASS.

- [ ] **Step 8: Review checkpoint**

Run: `git diff -- apps/server/src/config.ts apps/server/src/app.ts apps/server/src/index.ts scripts/dev.mjs apps/web/vite.config.ts apps/web/package.json`

Expected: Config only. Do not commit unless requested.

---

### Task 6: Diarization Opt-In Default

**Files:**
- Modify: `services/whisper/app/main.py`
- Modify: `services/whisper/app/transcriber.py`
- Modify: `services/whisper/tests/test_api.py`
- Modify: `services/whisper/tests/test_transcriber.py`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`

- [ ] **Step 1: Write failing Python API test**

In `services/whisper/tests/test_api.py`, update default transcribe expectation:

```python
def test_transcribe_endpoint_disables_diarization_by_default():
    transcriber = FakeTranscriber()
    client = TestClient(create_app(transcriber))
    response = client.post(
        "/transcribe",
        json={"audioPath": "recording.webm", "modelId": "small", "language": None},
    )

    assert response.status_code == 200
    assert transcriber.calls == [
        {
            "audio_path": "recording.webm",
            "model_id": "small",
            "language": None,
            "diarization": False,
        }
    ]
```

In `services/whisper/tests/test_transcriber.py`, replace `test_transcriber_uses_diarizer_by_default` with:

```python
def test_transcriber_skips_diarizer_by_default(tmp_path):
    audio_path = tmp_path / "recording.wav"
    audio_path.write_bytes(b"fake audio")
    diarizer = SpyDiarizer()
    transcriber = LocalTranscriber(diarizer=diarizer)
    transcriber._load_model = lambda model_id, compute_type: GoodModel()

    result = transcriber.transcribe(str(audio_path), "small", None)

    assert diarizer.available_calls == 0
    assert diarizer.diarize_calls == 0
    assert result["diarization"] == {"available": False, "enabled": False}
```

Add explicit-enabled test:

```python
def test_transcriber_uses_diarizer_when_explicitly_enabled(tmp_path):
    audio_path = tmp_path / "recording.wav"
    audio_path.write_bytes(b"fake audio")
    diarizer = SpyDiarizer()
    transcriber = LocalTranscriber(diarizer=diarizer)
    transcriber._load_model = lambda model_id, compute_type: GoodModel()

    result = transcriber.transcribe(str(audio_path), "small", None, diarization=True)

    assert diarizer.available_calls == 1
    assert diarizer.diarize_calls == 1
    assert result["diarization"] == {"available": True, "enabled": True}
```

- [ ] **Step 2: Run Python tests and verify RED**

Run: `npm run test:python`

Expected: FAIL because default diarization is still true.

- [ ] **Step 3: Implement Python default**

In `services/whisper/app/main.py`, change:

```python
diarization: bool = False
```

In `services/whisper/app/transcriber.py`, change:

```python
def transcribe(self, audio_path, model_id, language, diarization=False):
```

- [ ] **Step 4: Update frontend defaults**

In `apps/web/src/App.tsx`, change microphone session creation:

```typescript
diarization: false
```

Keep upload session creation from Task 2 as:

```typescript
diarization: false
```

Update `apps/web/src/App.test.tsx` expectations from `diarization: true` to `diarization: false`.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `npm run test:python`

Expected: PASS.

Run: `npm --workspace @meetingcpu/web test -- App.test.tsx`

Expected: PASS.

- [ ] **Step 6: Review checkpoint**

Run: `git diff -- services/whisper/app/main.py services/whisper/app/transcriber.py services/whisper/tests/test_api.py services/whisper/tests/test_transcriber.py apps/web/src/App.tsx apps/web/src/App.test.tsx`

Expected: Diarization default only. Do not commit unless requested.

---

### Task 7: Runtime Preflight

**Files:**
- Create: `apps/server/src/preflight.ts`
- Create: `apps/server/src/preflight.test.ts`
- Create: `apps/web/src/preflight/browserCapabilities.ts`
- Create: `apps/web/src/preflight/browserCapabilities.test.ts`
- Modify: `apps/server/src/routes.ts`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/api/client.test.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`

- [ ] **Step 1: Write failing preflight unit tests**

Create `apps/server/src/preflight.test.ts`:

```typescript
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runPreflight } from "./preflight.js";

describe("runPreflight", () => {
  it("reports writable storage and local model availability", async () => {
    const root = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const modelPath = join(root, "models", "models--Systran--faster-whisper-small");
    await writeFile(join(root, "probe.txt"), "ok");
    const result = await runPreflight({
      dataRoot: root,
      tmpRoot: root,
      modelsRoot: join(root, "models"),
      modelIds: ["small"],
      port: 5174,
      whisperPort: 8765,
      checkPortAvailable: vi.fn().mockResolvedValue(true),
      modelExists: vi.fn(async () => modelPath.endsWith("small"))
    });

    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "data-dir-writable", status: "ok" }),
      expect.objectContaining({ id: "tmp-dir-writable", status: "ok" }),
      expect.objectContaining({ id: "model-small", status: "ok" })
    ]));
  });

  it("separates optional diarization and ffmpeg fallback warnings from required blockers", async () => {
    const root = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const result = await runPreflight({
      dataRoot: root,
      tmpRoot: root,
      modelsRoot: join(root, "models"),
      modelIds: ["small"],
      port: 5174,
      whisperPort: 8765,
      enableDiarization: false,
      enableFfmpegUploadFallback: false,
      checkPortAvailable: vi.fn().mockResolvedValue(true),
      modelExists: vi.fn().mockResolvedValue(false)
    });

    expect(result.requiredOk).toBe(false);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "model-small", status: "error", required: true }),
      expect.objectContaining({ id: "diarization", status: "disabled", required: false }),
      expect.objectContaining({ id: "ffmpeg-upload-fallback", status: "disabled", required: false })
    ]));
  });
});
```

- [ ] **Step 2: Write failing route/client tests**

Add route test:

```typescript
it("returns preflight status", async () => {
  const app = createApp({
    dataRoot: await mkdtemp(join(tmpdir(), "meetingcpu-")),
    transcriptionClient: fakeTranscriptionClient()
  });

  const response = await request(app).get("/api/preflight").expect(200);

  expect(response.body).toHaveProperty("requiredOk");
  expect(response.body.checks).toEqual(expect.any(Array));
});
```

Add client test:

```typescript
it("loads preflight checks", async () => {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ requiredOk: true, checks: [] })
  });
  const client = createApiClient(fetchMock);

  await expect(client.getPreflight()).resolves.toEqual({ requiredOk: true, checks: [] });
  expect(fetchMock).toHaveBeenCalledWith("/api/preflight", undefined);
});
```

- [ ] **Step 3: Run tests and verify RED**

Run: `npm --workspace @meetingcpu/server test -- preflight.test.ts routes.test.ts`

Expected: FAIL because preflight module and route do not exist.

Run: `npm --workspace @meetingcpu/web test -- client.test.ts`

Expected: FAIL because client has no `getPreflight`.

- [ ] **Step 4: Implement preflight module**

Create `apps/server/src/preflight.ts`:

```typescript
import { access, mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface PreflightCheck {
  id: string;
  label: string;
  status: "ok" | "warning" | "error" | "disabled";
  required: boolean;
  message: string;
}

export interface PreflightInput {
  dataRoot: string;
  tmpRoot: string;
  modelsRoot: string;
  modelIds: string[];
  port: number;
  whisperPort: number;
  enableDiarization?: boolean;
  enableFfmpegUploadFallback?: boolean;
  checkPortAvailable?: (port: number) => Promise<boolean>;
  modelExists?: (path: string) => Promise<boolean>;
}

export async function runPreflight(input: PreflightInput): Promise<{ requiredOk: boolean; checks: PreflightCheck[] }> {
  const checks: PreflightCheck[] = [];
  checks.push(await writableDirectoryCheck("data-dir-writable", "Data directory", input.dataRoot, true));
  checks.push(await writableDirectoryCheck("tmp-dir-writable", "Temporary directory", input.tmpRoot, true));
  checks.push(await portCheck("server-port", "Node API port", input.port, input.checkPortAvailable));
  checks.push(await portCheck("whisper-port", "Whisper service port", input.whisperPort, input.checkPortAvailable));
  for (const modelId of input.modelIds) {
    checks.push(await modelCheck(input.modelsRoot, modelId, input.modelExists));
  }
  checks.push(optionalCheck("diarization", "Speaker labels", input.enableDiarization === true));
  checks.push(optionalCheck("ffmpeg-upload-fallback", "Server ffmpeg upload fallback", input.enableFfmpegUploadFallback === true));
  return {
    requiredOk: checks.every((check) => !check.required || check.status === "ok"),
    checks
  };
}

async function writableDirectoryCheck(id: string, label: string, path: string, required: boolean): Promise<PreflightCheck> {
  try {
    await mkdir(path, { recursive: true });
    const probe = join(path, `.meetingcpu-preflight-${process.pid}.tmp`);
    await writeFile(probe, "ok");
    await unlink(probe);
    return { id, label, status: "ok", required, message: `${label} is writable.` };
  } catch (error) {
    return { id, label, status: "error", required, message: `${label} is not writable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function portCheck(id: string, label: string, port: number, checkPortAvailable?: (port: number) => Promise<boolean>): Promise<PreflightCheck> {
  const available = checkPortAvailable ? await checkPortAvailable(port) : true;
  return available
    ? { id, label, status: "ok", required: true, message: `${label} ${port} is configured.` }
    : { id, label, status: "error", required: true, message: `${label} ${port} is unavailable.` };
}

async function modelCheck(modelsRoot: string, modelId: string, modelExists?: (path: string) => Promise<boolean>): Promise<PreflightCheck> {
  const path = join(modelsRoot, `models--Systran--faster-whisper-${modelId}`);
  const exists = modelExists ? await modelExists(path) : await existsPath(path);
  return exists
    ? { id: `model-${modelId}`, label: `Model ${modelId}`, status: "ok", required: true, message: `Model ${modelId} is available locally.` }
    : { id: `model-${modelId}`, label: `Model ${modelId}`, status: "error", required: true, message: `Model ${modelId} is missing from ${modelsRoot}.` };
}

function optionalCheck(id: string, label: string, enabled: boolean): PreflightCheck {
  return enabled
    ? { id, label, status: "warning", required: false, message: `${label} is enabled and depends on optional native components.` }
    : { id, label, status: "disabled", required: false, message: `${label} is disabled.` };
}

async function existsPath(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Wire route and client**

In `apps/server/src/routes.ts`, import:

```typescript
import { runPreflight } from "./preflight.js";
```

Add route:

```typescript
router.get("/preflight", asyncHandler(async (_request, response) => {
  response.json(await runPreflight({
    dataRoot: dependencies.dataRoot,
    tmpRoot: dependencies.tmpRoot ?? join(dependencies.dataRoot, "tmp"),
    modelsRoot: dependencies.modelsRoot ?? "models",
    modelIds: [DEFAULT_MODEL_ID],
    port: dependencies.serverPort ?? 5174,
    whisperPort: dependencies.whisperPort ?? 8765,
    enableDiarization: dependencies.enableDiarization,
    enableFfmpegUploadFallback: dependencies.enableFfmpegUploadFallback
  }));
}));
```

Extend `RouteDependencies` with `tmpRoot`, `modelsRoot`, `serverPort`, `whisperPort`, and `enableDiarization`.

In `apps/web/src/api/client.ts`, add:

```typescript
export interface PreflightResponse {
  requiredOk: boolean;
  checks: Array<{ id: string; label: string; status: "ok" | "warning" | "error" | "disabled"; required: boolean; message: string }>;
}
```

Add client method:

```typescript
async getPreflight(): Promise<PreflightResponse> {
  const response = await fetchOrThrow(fetchImpl, "/api/preflight", undefined, "Could not load preflight checks.");
  if (!response.ok) throw new Error(await readErrorMessage(response, "Could not load preflight checks."));
  return response.json() as Promise<PreflightResponse>;
}
```

- [ ] **Step 6: Add browser capability checks**

Create `apps/web/src/preflight/browserCapabilities.ts`:

```typescript
export interface BrowserCapabilityCheck {
  id: string;
  label: string;
  status: "ok" | "warning" | "error";
  message: string;
}

type BrowserGlobal = typeof globalThis & {
  webkitAudioContext?: typeof AudioContext;
};

export function getBrowserCapabilityChecks(globalScope: BrowserGlobal = globalThis as BrowserGlobal): BrowserCapabilityCheck[] {
  return [
    capability("browser-upload-decode", "Browser upload decoding", typeof globalScope.AudioContext !== "undefined" || typeof globalScope.webkitAudioContext !== "undefined"),
    capability("microphone-recording", "Microphone recording", Boolean(globalScope.navigator?.mediaDevices?.getUserMedia) && typeof globalScope.MediaRecorder !== "undefined"),
    capability("session-events", "Session event streaming", typeof globalScope.EventSource !== "undefined")
  ];
}

function capability(id: string, label: string, available: boolean): BrowserCapabilityCheck {
  return available
    ? { id, label, status: "ok", message: `${label} is supported.` }
    : { id, label, status: "error", message: `${label} is not supported in this browser environment.` };
}
```

Create `apps/web/src/preflight/browserCapabilities.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { getBrowserCapabilityChecks } from "./browserCapabilities";

describe("getBrowserCapabilityChecks", () => {
  it("reports upload, microphone, and event support", () => {
    const checks = getBrowserCapabilityChecks({
      AudioContext: vi.fn(),
      MediaRecorder: vi.fn(),
      EventSource: vi.fn(),
      navigator: { mediaDevices: { getUserMedia: vi.fn() } }
    } as unknown as typeof globalThis);

    expect(checks.every((check) => check.status === "ok")).toBe(true);
  });

  it("reports missing browser capabilities clearly", () => {
    const checks = getBrowserCapabilityChecks({ navigator: {} } as typeof globalThis);

    expect(checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "browser-upload-decode", status: "error" }),
      expect.objectContaining({ id: "microphone-recording", status: "error" }),
      expect.objectContaining({ id: "session-events", status: "error" })
    ]));
  });
});
```

Run: `npm --workspace @meetingcpu/web test -- browserCapabilities.test.ts`

Expected: FAIL until the new files are created, then PASS.

- [ ] **Step 7: Add minimal UI display**

In `apps/web/src/App.tsx`, add `getPreflight` to `AppApi` pick and load checks after models:

```typescript
const [preflightMessages, setPreflightMessages] = useState<string[]>([]);
```

Import browser checks:

```typescript
import { getBrowserCapabilityChecks } from "./preflight/browserCapabilities";
```

Inside model loading success path:

```typescript
const preflight = "getPreflight" in api ? await api.getPreflight().catch(() => null) : null;
const browserMessages = getBrowserCapabilityChecks().filter((check) => check.status !== "ok").map((check) => check.message);
const serverMessages = preflight?.checks.filter((check) => check.status !== "ok").map((check) => check.message) ?? [];
setPreflightMessages([...serverMessages, ...browserMessages]);
```

Render below controls:

```tsx
{preflightMessages.length > 0 ? (
  <ul className="preflight-list" aria-label="Machine compatibility checks">
    {preflightMessages.map((message) => <li key={message}>{message}</li>)}
  </ul>
) : null}
```

- [ ] **Step 8: Run tests and verify GREEN**

Run: `npm --workspace @meetingcpu/server test -- preflight.test.ts routes.test.ts`

Expected: PASS.

Run: `npm --workspace @meetingcpu/web test -- client.test.ts App.test.tsx`

Expected: PASS.

Run: `npm --workspace @meetingcpu/web test -- browserCapabilities.test.ts`

Expected: PASS.

- [ ] **Step 9: Review checkpoint**

Run: `git diff -- apps/server/src/preflight.ts apps/server/src/preflight.test.ts apps/server/src/routes.ts apps/web/src/api/client.ts apps/web/src/api/client.test.ts apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/preflight/browserCapabilities.ts apps/web/src/preflight/browserCapabilities.test.ts`

Expected: Preflight only. Do not commit unless requested.

---

### Task 8: Setup and Documentation

**Files:**
- Modify: `README.md`
- Modify: `scripts/setup-python.mjs`
- Modify: `scripts/dev-result.test.mjs`

- [ ] **Step 1: Write failing script behavior test**

In `scripts/dev-result.test.mjs` or a new setup script test, add:

```javascript
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("restricted machine setup docs contract", () => {
  it("documents npm.cmd and browser upload chunking", async () => {
    const readme = await import("node:fs/promises").then((fs) => fs.readFile("README.md", "utf8"));

    assert.match(readme, /npm\.cmd run dev/);
    assert.match(readme, /browser-side upload chunking/i);
    assert.match(readme, /MEETINGCPU_DATA_DIR/);
    assert.match(readme, /MEETINGCPU_ENABLE_FFMPEG_UPLOAD_FALLBACK/);
  });
});
```

- [ ] **Step 2: Run test and verify RED**

Run: `npm run test:scripts`

Expected: FAIL because README does not document the new restricted-machine flow.

- [ ] **Step 3: Update README**

Update `README.md` sections:

```markdown
## Restricted Corporate Machines

Use `npm.cmd run dev` when PowerShell blocks `npm.ps1`.

Uploaded files use browser-side upload chunking by default. The browser decodes the selected file, creates local WAV chunks, sends them through the same saved-session pipeline used by microphone recording, and does not require `FFMPEG_PATH` or `ffmpeg` on `PATH`.

If the browser cannot decode a file, convert it to WAV, MP3, M4A, or WebM on an approved machine, or explicitly enable the optional server fallback with `MEETINGCPU_ENABLE_FFMPEG_UPLOAD_FALLBACK=true` after making ffmpeg available.

Recommended writable locations:

```powershell
$env:MEETINGCPU_DATA_DIR="$env:LOCALAPPDATA\meetingcpu\data"
$env:MEETINGCPU_MODELS_DIR="$env:LOCALAPPDATA\meetingcpu\models"
$env:MEETINGCPU_TMP_DIR="$env:LOCALAPPDATA\meetingcpu\tmp"
npm.cmd run dev
```

Ports can be changed when defaults are occupied:

```powershell
$env:MEETINGCPU_WEB_PORT="6173"
$env:MEETINGCPU_SERVER_PORT="6174"
$env:MEETINGCPU_WHISPER_PORT="6175"
npm.cmd run dev
```
```

Update FFmpeg section to state it is optional fallback only.

Update diarization section to state speaker labels are off by default and opt-in.

- [ ] **Step 4: Optional setup script skip**

If `npm install` postinstall remains too aggressive, update `scripts/setup-python.mjs` to support:

```javascript
if (process.env.MEETINGCPU_SKIP_PYTHON_SETUP === "true") {
  console.log("[setup] Skipping Python setup because MEETINGCPU_SKIP_PYTHON_SETUP=true.");
  process.exit(0);
}
```

Add README:

```markdown
Set `MEETINGCPU_SKIP_PYTHON_SETUP=true` only when you have already prepared `.venv` and local models.
```

- [ ] **Step 5: Run script tests and verify GREEN**

Run: `npm run test:scripts`

Expected: PASS.

- [ ] **Step 6: Review checkpoint**

Run: `git diff -- README.md scripts/setup-python.mjs scripts/dev-result.test.mjs`

Expected: Restricted-machine docs and optional setup skip only. Do not commit unless requested.

---

### Task 9: Final Verification

**Files:**
- All changed files.

- [ ] **Step 1: Run focused web tests**

Run: `npm --workspace @meetingcpu/web test -- uploadChunker.test.ts App.test.tsx client.test.ts`

Expected: PASS.

- [ ] **Step 2: Run focused server tests**

Run: `npm --workspace @meetingcpu/server test -- config.test.ts preflight.test.ts routes.test.ts`

Expected: PASS.

- [ ] **Step 3: Run Python tests**

Run: `npm run test:python`

Expected: PASS.

- [ ] **Step 4: Run full test suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 5: Run build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 6: Code graph review context**

Run code graph review context for:

```text
apps/web/src/audio/uploadChunker.ts
apps/web/src/App.tsx
apps/web/src/api/client.ts
apps/server/src/routes.ts
apps/server/src/config.ts
apps/server/src/preflight.ts
services/whisper/app/main.py
services/whisper/app/transcriber.py
```

Expected: high-risk flows identified and reviewed before final handoff.

- [ ] **Step 7: Final diff review**

Run: `git status --short`

Run: `git diff --stat`

Expected: Only files in this plan are changed. Do not commit unless requested.
