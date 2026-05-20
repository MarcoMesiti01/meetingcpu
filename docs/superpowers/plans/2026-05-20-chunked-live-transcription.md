# Chunked Live Transcription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build chunked local meeting transcription with live browser updates, locally saved in-progress transcript text, optional pyannote speaker labels, and a quiet professional dashboard UI.

**Architecture:** The browser creates a session and uploads 30-second microphone chunks every 25 seconds. The Node server stores chunks, queues one local transcription job at a time, appends accepted chunk text to `transcript.in-progress.txt`, publishes Server-Sent Events, and finalizes from saved chunk results without retranscribing the full recording. The Python service returns chunk transcript segments with optional local diarization labels.

**Tech Stack:** TypeScript, Express, Multer disk storage, Server-Sent Events, Vite React, MediaRecorder, FastAPI, faster-whisper, optional pyannote.audio, pytest, Vitest.

---

## Graph Context For Subagents

Use the code-review graph before changing a task area:

```text
mcp__code_review_graph__.query_graph_tool(file_summary, <target file>)
mcp__code_review_graph__.query_graph_tool(tests_for, <target file or symbol>)
mcp__code_review_graph__.get_impact_radius_tool(changed_files=[...])
```

Known graph anchors:

- `apps/server/src/routes.ts`: current upload/transcription API.
- `apps/server/src/sessions.ts`: local session metadata and transcript persistence.
- `apps/server/src/transcriptionClient.ts`: Node client for Python service.
- `services/whisper/app/main.py`: FastAPI `/transcribe` boundary.
- `services/whisper/app/transcriber.py`: faster-whisper wrapper.
- `apps/web/src/App.tsx`: current browser UI.
- `apps/web/src/api/client.ts`: browser API client.
- `apps/web/src/audio/recorder.ts`: current microphone recorder wrapper.

## File Structure

- Create `apps/server/src/chunkSessions.ts`: chunk persistence, in-progress transcript append, final assembly, manifest writes.
- Create `apps/server/src/chunkSessions.test.ts`: chunk persistence tests.
- Create `apps/server/src/sessionEvents.ts`: per-session SSE event hub.
- Create `apps/server/src/sessionEvents.test.ts`: event hub tests.
- Create `apps/server/src/chunkQueue.ts`: single-worker chunk transcription queue.
- Create `apps/server/src/chunkQueue.test.ts`: queue ordering/failure tests.
- Modify `apps/server/src/routes.ts`: add session/chunk/finalize/SSE routes and route upload through chunk pipeline.
- Modify `apps/server/src/routes.test.ts`: API tests for chunk session flow, failure metadata, and upload ffmpeg error.
- Modify `apps/server/src/transcriptionClient.ts`: support chunk response shape and diarization status.
- Modify `apps/server/src/transcriptionClient.test.ts`: test speaker/status parsing.
- Modify `apps/server/package.json`: add `ffmpeg-static` as an optional/dev dependency for local upload chunking fallback.
- Modify `services/whisper/requirements.txt`: add optional diarization dependencies only if they can be imported lazily.
- Create `services/whisper/app/diarization.py`: optional pyannote boundary.
- Modify `services/whisper/app/main.py`: include diarization status in `/health`, return chunk response shape.
- Modify `services/whisper/app/transcriber.py`: include segment ids and speaker label fields.
- Create/modify `services/whisper/tests/test_diarization.py`: fake diarization success/fallback tests.
- Modify `services/whisper/tests/test_api.py` and `test_transcriber.py`: chunk response shape tests.
- Modify `scripts/setup-python.mjs`: add explicit diarization setup/download command.
- Modify `scripts/download-model.py`: keep Whisper model download validation.
- Create `scripts/download-diarization.py`: downloads pyannote pipeline with `HF_TOKEN`.
- Modify `package.json`: add `download:diarization` script.
- Modify `apps/web/src/audio/recorder.ts`: add chunk recorder API.
- Modify `apps/web/src/audio/recorder.test.ts`: chunk timing/overlap tests with fake timers.
- Modify `apps/web/src/api/client.ts`: session/chunk/finalize/SSE client methods.
- Modify `apps/web/src/api/client.test.ts`: API client tests.
- Modify `apps/web/src/App.tsx`: live session UI state.
- Modify `apps/web/src/App.test.tsx`: live chunk display, finalization, pyannote fallback/status tests.
- Modify `apps/web/src/styles.css`: quiet professional dashboard styling.
- Modify `README.md`: chunking behavior, in-progress transcript file, pyannote.audio install/run instructions, diarization fallback, ffmpeg upload requirement.

## Task 1: Server Chunk Persistence

**Files:**
- Create: `apps/server/src/chunkSessions.ts`
- Create: `apps/server/src/chunkSessions.test.ts`
- Modify: `apps/server/src/sessions.ts` to export shared `writeMetadata` support or keep chunk metadata isolated in `chunkSessions.ts`

- [ ] **Step 1: Write failing tests for chunk persistence**

Create tests covering:

- `createChunkSession()` creates `chunks/`, `chunk-results/`, `recording.manifest.json`, `transcript.in-progress.txt`, and metadata.
- `saveChunkFile()` stores `chunk-000001.webm` from a disk path and records start/end/overlap/mime/size in the manifest.
- `saveChunkResult()` stores `chunk-results/chunk-000001.json` and appends de-duplicated transcript lines to `transcript.in-progress.txt`.
- `finalizeChunkSession()` writes `transcript.txt` and `transcript.json` from saved chunk results.
- failed chunks are represented in metadata without deleting prior transcript text.

Run:

```bash
npm.cmd --workspace @meetingcpu/server test -- src/chunkSessions.test.ts
```

Expected: fails before implementation because `chunkSessions.ts` does not exist.

- [ ] **Step 2: Implement chunk persistence**

Implement these exported types/functions:

```ts
export interface ChunkSession extends Session {
  chunksPath: string;
  chunkResultsPath: string;
  manifestPath: string;
  inProgressTranscriptPath: string;
}

export interface ChunkManifestEntry {
  index: number;
  fileName: string;
  path: string;
  startSeconds: number;
  endSeconds: number;
  overlapSeconds: number;
  mimeType: string;
  byteSize: number;
  status: "saved" | "transcribed" | "failed";
}

export interface ChunkTranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface ChunkTranscriptResult {
  chunkIndex: number;
  text: string;
  language: string;
  durationSeconds: number;
  segments: ChunkTranscriptSegment[];
  diarization: { available: boolean; enabled: boolean; error?: string };
}
```

The append format for in-progress text is:

```text
[00:00:05] Speaker 1: Text
[00:00:12] Text without speaker
```

Overlap de-duplication for v1: discard segments whose absolute `end` time is less than or equal to the previous committed transcript end time. Store `lastCommittedEndSeconds` in metadata.

- [ ] **Step 3: Verify and commit**

Run:

```bash
npm.cmd --workspace @meetingcpu/server test -- src/chunkSessions.test.ts
npm.cmd --workspace @meetingcpu/server run build
```

Commit:

```bash
git add apps/server/src/chunkSessions.ts apps/server/src/chunkSessions.test.ts apps/server/src/sessions.ts
git commit -m "feat: persist chunked transcription sessions"
```

## Task 2: Server Events And Chunk Queue

**Files:**
- Create: `apps/server/src/sessionEvents.ts`
- Create: `apps/server/src/sessionEvents.test.ts`
- Create: `apps/server/src/chunkQueue.ts`
- Create: `apps/server/src/chunkQueue.test.ts`

- [ ] **Step 1: Write event hub tests**

Cover subscribe/unsubscribe, replay of latest session state, JSON SSE formatting, and event ordering.

- [ ] **Step 2: Implement event hub**

Expose:

```ts
export type SessionEvent =
  | { type: "session-created"; sessionId: string; sessionPath: string; inProgressTranscriptPath: string }
  | { type: "chunk-saved"; sessionId: string; chunkIndex: number }
  | { type: "chunk-transcribed"; sessionId: string; chunkIndex: number; text: string; diarization: { available: boolean; enabled: boolean; error?: string } }
  | { type: "chunk-failed"; sessionId: string; chunkIndex: number; code: string; message: string }
  | { type: "session-finalized"; sessionId: string; transcriptPath: string; partial: boolean };
```

Use plain Node `Response` writes for SSE:

```text
event: chunk-transcribed
data: {...}
```

- [ ] **Step 3: Write queue tests**

Cover single concurrency, FIFO order, failure event emission, and finalization waiting for active jobs.

- [ ] **Step 4: Implement queue**

Expose a `ChunkQueue` class with `enqueue(input)`, `waitForSession(sessionId)`, and serial processing. One process-wide worker is enough for CPU safety in v1.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm.cmd --workspace @meetingcpu/server test -- src/sessionEvents.test.ts src/chunkQueue.test.ts
```

Commit:

```bash
git add apps/server/src/sessionEvents.ts apps/server/src/sessionEvents.test.ts apps/server/src/chunkQueue.ts apps/server/src/chunkQueue.test.ts
git commit -m "feat: add live session events and chunk queue"
```

## Task 3: Python Chunk Transcription And Optional Diarization

**Files:**
- Create: `services/whisper/app/diarization.py`
- Create: `services/whisper/tests/test_diarization.py`
- Modify: `services/whisper/app/main.py`
- Modify: `services/whisper/app/transcriber.py`
- Modify: `services/whisper/tests/test_api.py`
- Modify: `services/whisper/tests/test_transcriber.py`
- Modify: `services/whisper/requirements.txt`
- Create: `scripts/download-diarization.py`
- Modify: `scripts/setup-python.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add tests for chunk response shape**

Python `/transcribe` and `LocalTranscriber.transcribe()` must return:

```json
{
  "text": "Hello",
  "language": "en",
  "durationSeconds": 5.0,
  "segments": [{"start": 0, "end": 5, "text": "Hello", "speaker": "Speaker 1"}],
  "diarization": {"available": true, "enabled": true}
}
```

Tests must also cover diarization unavailable fallback:

```json
"diarization": {"available": false, "enabled": false, "error": "..."}
```

- [ ] **Step 2: Implement lazy diarization boundary**

`services/whisper/app/diarization.py` should lazily import pyannote and expose:

```py
class DiarizationUnavailable(Exception): ...
class LocalDiarizer:
    def is_available(self) -> bool: ...
    def diarize(self, audio_path: str) -> list[dict]: ...
```

If `pyannote.audio` or local model files are missing, return unavailable status without breaking transcription.

- [ ] **Step 3: Add setup command**

Add root script:

```json
"download:diarization": "node scripts/setup-python.mjs --download-diarization"
```

`scripts/download-diarization.py` should require `HF_TOKEN` and download/cache the pyannote pipeline locally. It must print clear instructions if token or terms are missing. README details are handled in Task 8.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npm.cmd run test:python
.venv\Scripts\python.exe scripts\download-diarization.py --check-only
```

Commit:

```bash
git add services/whisper scripts package.json package-lock.json
git commit -m "feat: add optional local diarization boundary"
```

## Task 4: Session Routes, SSE, Finalize, And Upload Chunking

**Files:**
- Modify: `apps/server/src/routes.ts`
- Modify: `apps/server/src/routes.test.ts`
- Modify: `apps/server/src/transcriptionClient.ts`
- Modify: `apps/server/src/transcriptionClient.test.ts`
- Modify: `apps/server/package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write failing API route tests**

Cover:

- `POST /api/sessions` returns `sessionId`, `sessionPath`, `inProgressTranscriptPath`.
- `GET /api/sessions/:id/events` streams SSE events.
- `POST /api/sessions/:id/chunks` saves chunk and enqueues transcription.
- transcribed chunk appends to `transcript.in-progress.txt`.
- `POST /api/sessions/:id/finalize` waits for queue and writes final transcript.
- chunk transcription failure emits `chunk-failed`, records metadata, and finalizes partial transcript.
- upload path returns controlled ffmpeg error when ffmpeg is unavailable.

- [ ] **Step 2: Implement routes**

Add the session routes. Keep `/api/transcriptions` available, but route uploads through the chunk pipeline when ffmpeg is configured. If ffmpeg is not configured, return:

```json
{
  "code": "UPLOAD_CHUNKING_UNAVAILABLE",
  "message": "Upload chunking requires ffmpeg. Install ffmpeg or set FFMPEG_PATH."
}
```

- [ ] **Step 3: Update transcription client**

Ensure Node accepts `diarization` and segment `speaker` fields from Python and preserves them through chunk results.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npm.cmd --workspace @meetingcpu/server test
npm.cmd --workspace @meetingcpu/server run build
```

Commit:

```bash
git add apps/server package-lock.json
git commit -m "feat: add chunked transcription API"
```

## Task 5: Browser Chunk Recorder And API Client

**Files:**
- Modify: `apps/web/src/audio/recorder.ts`
- Modify: `apps/web/src/audio/recorder.test.ts`
- Modify: `apps/web/src/api/client.ts`
- Modify: `apps/web/src/api/client.test.ts`

- [ ] **Step 1: Write chunk recorder tests**

Use fake timers and fake `MediaRecorder` to verify:

- one microphone stream is reused;
- chunks are emitted with indexes and start/end/overlap metadata;
- second recorder starts 25 seconds after first to create overlap;
- stop resolves only after active recorders flush;
- tracks are stopped after final stop.

- [ ] **Step 2: Implement recorder**

Keep existing `start()`/`stop()` compatibility for the upload-on-stop fallback tests, and add:

```ts
startChunked(options: {
  chunkSeconds: number;
  overlapSeconds: number;
  onChunk(chunk: RecordedChunk): void | Promise<void>;
}): Promise<void>
stopChunked(): Promise<void>
```

`RecordedChunk` includes `blob`, `index`, `startSeconds`, `endSeconds`, `overlapSeconds`, `mimeType`.

- [ ] **Step 3: Add API client methods**

Expose:

```ts
createSession(input: { title: string; modelId: string })
uploadChunk(sessionId: string, chunk: RecordedChunk)
openSessionEvents(sessionId: string, handlers)
finalizeSession(sessionId: string)
```

- [ ] **Step 4: Verify and commit**

Run:

```bash
npm.cmd --workspace @meetingcpu/web test -- src/audio/recorder.test.ts src/api/client.test.ts
npm.cmd --workspace @meetingcpu/web run build
```

Commit:

```bash
git add apps/web/src/audio apps/web/src/api
git commit -m "feat: add browser chunk recording client"
```

## Task 6: Live Transcript Dashboard UI

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Write UI tests**

Cover:

- start creates a session and opens events;
- chunk events append live transcript text;
- UI shows `transcript.in-progress.txt` save path;
- diarization status displays available/unavailable;
- stop finalizes instead of uploading a full recording;
- chunk failure displays a warning while preserving previous transcript text;
- upload shows ffmpeg requirement error when server returns it.

- [ ] **Step 2: Implement session UI state**

Replace microphone happy path with session flow:

```text
ready -> recording -> finalizing -> complete
```

Live transcript state is built from `chunk-transcribed` events. The UI must show:

- elapsed time;
- chunks saved/transcribed;
- current queue/finalizing state;
- in-progress transcript path;
- diarization status;
- transcript stream grouped by speaker/timestamp.

- [ ] **Step 3: Apply quiet professional dashboard styling**

Use restrained colors, compact sections, aligned controls, and a transcript-first workspace. Do not add a marketing hero, decorative gradients, or nested cards.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npm.cmd --workspace @meetingcpu/web test -- src/App.test.tsx
npm.cmd --workspace @meetingcpu/web run build
```

Commit:

```bash
git add apps/web/src/App.tsx apps/web/src/App.test.tsx apps/web/src/styles.css
git commit -m "feat: show live chunked transcription dashboard"
```

## Task 7: Upload Compatibility Through Chunk Pipeline

**Files:**
- Modify: `apps/server/src/routes.ts`
- Modify: `apps/server/src/routes.test.ts`
- Create: `apps/server/src/ffmpegChunks.ts`
- Create: `apps/server/src/ffmpegChunks.test.ts`
- Modify: `README.md` if upload limitation text needs refinement

- [ ] **Step 1: Add ffmpeg chunking tests**

Tests must cover:

- `resolveFfmpegPath()` uses `FFMPEG_PATH` first.
- missing ffmpeg returns `UPLOAD_CHUNKING_UNAVAILABLE`.
- ffmpeg command arguments include 30-second segment duration and local output path.

- [ ] **Step 2: Implement ffmpeg chunk helper**

Use `child_process.spawn` with argument arrays. Do not shell-concatenate paths.

- [ ] **Step 3: Wire upload endpoint**

For `sourceType=upload`, save upload, split into chunks, enqueue chunks, wait/finalize, and return transcript response compatible with existing UI/API. If ffmpeg is unavailable, return the controlled error.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npm.cmd --workspace @meetingcpu/server test -- src/ffmpegChunks.test.ts src/routes.test.ts
npm.cmd --workspace @meetingcpu/server run build
```

Commit:

```bash
git add apps/server/src/ffmpegChunks.ts apps/server/src/ffmpegChunks.test.ts apps/server/src/routes.ts apps/server/src/routes.test.ts README.md
git commit -m "feat: chunk uploaded audio locally"
```

## Task 8: README And Local Setup Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document chunked live transcription**

Add:

- microphone recordings are processed in 30-second chunks with 5-second overlap;
- `transcript.in-progress.txt` is saved after each completed chunk;
- final transcript is assembled from chunk results, not retranscribed from full audio;
- session chunk files are saved under `data/sessions/<id>/chunks`.

- [ ] **Step 2: Document pyannote.audio install and run instructions**

Add exact instructions:

```bash
npm install
$env:HF_TOKEN="hf_your_token_here"
npm run download:diarization
npm run dev
```

Also document:

- users must accept the relevant pyannote model terms on Hugging Face before first download;
- diarization is optional;
- after download, diarization runs locally/offline from cache;
- if unavailable, transcription still runs without speaker labels;
- CPU laptops may find diarization slower than transcription.

- [ ] **Step 3: Verify and commit**

Run:

```bash
npm.cmd test
npm.cmd run build
```

Commit:

```bash
git add README.md
git commit -m "docs: explain chunking and diarization setup"
```

## Task 9: End-To-End Verification And Final Review

**Files:**
- Modify only if verification reveals a bug.

- [ ] **Step 1: Run full verification**

Run:

```bash
npm.cmd test
npm.cmd run build
```

- [ ] **Step 2: Run local dev smoke test**

Start:

```bash
npm.cmd run dev
```

Verify:

- web loads at `http://127.0.0.1:5173/`;
- API health returns 200;
- Whisper health returns 200 and reports diarization availability;
- starting recording creates a session;
- at least one chunk reaches the server and creates `transcript.in-progress.txt` with fake or real transcribed text depending on local model availability.

- [ ] **Step 3: Final code review**

Use a fresh subagent to review the full branch for:

- long-meeting chunking correctness;
- no full-recording retranscription on microphone finalize;
- partial transcript persistence;
- diarization fallback;
- UI/dashboard quality;
- README pyannote instructions.

- [ ] **Step 4: Finish branch**

Use `superpowers:finishing-a-development-branch` after all tests pass.

## Self-Review

- Spec coverage: chunking, live updates, in-progress text, optional diarization, upload compatibility, UI refresh, README pyannote instructions, and verification are mapped to tasks.
- Placeholder scan: no TBD/TODO placeholders remain.
- Type consistency: `ChunkTranscriptResult`, `diarization`, `speaker`, `chunkIndex`, and session event names are consistent across server, Python, and frontend tasks.
