# Restricted Machine Compatibility Design

## Goal

Make meetingcpu reliable on corporate-restricted Windows laptops where global `PATH` edits, FFmpeg installation, native binary downloads, fixed localhost ports, and repo-relative writable folders may be blocked.

The app remains a local-first personal work tool launched with `npm run dev` or `npm.cmd run dev`. The design optimizes for predictable daily use on one machine, not distribution to many users.

## Scope

This design covers:

- ffmpeg-free uploaded-file transcription as a primary supported path;
- continued ffmpeg-free live microphone transcription;
- optional server-side ffmpeg only as a fallback, not a requirement;
- restricted-machine preflight checks for install/runtime risks;
- safer defaults for data/model/temp storage;
- configurable local ports and local browser origins;
- diarization as an explicit optional capability;
- setup documentation for offline/cache/proxy-constrained environments.

This design does not cover:

- packaging as a signed corporate desktop application;
- bypassing corporate security controls;
- cloud transcription or cloud storage;
- guaranteeing support for codecs the browser cannot decode;
- enterprise deployment to many laptops.

## Current Constraints

The current app has two audio paths:

- Live microphone recording uses browser `MediaRecorder` chunking and sends chunks to `POST /api/sessions/:id/chunks`. This path does not require ffmpeg on the Node server.
- Uploaded files use `POST /api/transcriptions` with `sourceType=upload`, then `handleUploadTranscription` resolves ffmpeg and splits audio server-side. This path fails when `FFMPEG_PATH` cannot be configured and `ffmpeg` is not available on `PATH`.

Other restricted-machine risks:

- `npm install` currently bootstraps Python, installs dependencies, and downloads the default model through `postinstall`.
- PowerShell execution policy can block `npm.ps1`.
- Fixed ports `5173`, `5174`, and `8765` can be occupied or blocked.
- CORS currently trusts loopback origins only.
- Browser APIs such as `getUserMedia`, `MediaRecorder`, `AudioContext`, and `EventSource` can be disabled or unavailable.
- Repo-relative `data/`, `models/`, `.venv`, and temporary folders may be protected, synced, scanned, or locked by antivirus.
- Model downloads and native Python wheels can fail behind corporate proxy/TLS inspection.
- Diarization depends on pyannote/torchcodec and FFmpeg DLL loading on Windows.

## Product Behavior

### Live Microphone Flow

Live microphone recording remains the preferred daily-meeting path. The browser records short overlapping chunks and uploads them to the existing chunk-session APIs. The server stores each chunk, transcribes it through the local Python service, updates `transcript.in-progress.txt`, and finalizes from saved chunk results.

If microphone APIs are unavailable, the app should not fail at startup. It should show that live recording is unavailable and still allow uploaded-file transcription when browser file decoding is supported.

### Uploaded File Flow

Uploaded files must work reliably without server-side ffmpeg.

The browser should decode the selected file using Web Audio APIs, split decoded PCM into 30-second windows with the configured overlap, encode each window as a WAV blob, and send those WAV chunks through the same session chunk APIs used by microphone recording:

```text
POST /api/sessions
POST /api/sessions/:sessionId/chunks
POST /api/sessions/:sessionId/finalize
```

This avoids global executable discovery, `PATH` mutation, and project-bundled native media tools. It also preserves the existing chunk queue, partial transcript behavior, saved manifests, and final assembly logic.

The UI should show upload progress in terms of chunks prepared, uploaded, transcribed, and failed. If one uploaded chunk fails, the session can still finalize as partial using existing chunk failure behavior.

### Unsupported Uploaded Codecs

Browser decoding will not support every audio codec. When decoding fails, the app should return a clear local error:

```text
This audio format is not supported by your browser on this machine. Try WAV, MP3, M4A, or WebM, or enable the optional server ffmpeg fallback.
```

The optional server ffmpeg fallback may remain available for machines where ffmpeg is already usable, but it must not be the default path and must not be required for the app’s normal upload workflow.

## Architecture

### Browser Upload Chunker

Add a focused browser-side upload chunker responsible for:

- reading a selected `File`;
- decoding it with `AudioContext.decodeAudioData`;
- slicing decoded PCM into chunk windows;
- encoding each chunk as WAV;
- preserving chunk metadata: index, start seconds, end seconds, overlap seconds, MIME type, file name;
- surfacing unsupported-decoder and memory errors clearly.

This should be separate from `BrowserAudioRecorder` because recording a live stream and chunking an existing decoded file have different dependencies and failure modes.

The first implementation can decode the full file into memory because the app is personal-use and meeting files are expected to be bounded by the existing upload size limit. The UI and docs should set expectations for very large files. Streaming decode is out of scope for this implementation.

### Browser App Flow

Replace the current uploaded-file call to `api.transcribeAudio({ sourceType: "upload" })` with a chunk-session workflow:

1. Create a chunk session with `sourceType` equivalent metadata for upload.
2. Decode and emit upload chunks in the browser.
3. Upload each WAV chunk using `uploadSessionChunk`.
4. Subscribe to session events for progress and transcript updates when available.
5. Finalize the session after all upload chunks are accepted.
6. Render final or partial transcript from the finalized session.

The existing single-file `/api/transcriptions` path can remain for microphone legacy compatibility and optional ffmpeg fallback, but the UI should use the chunk-session flow for uploads.

### Node Server

The Node server should keep the chunk-session APIs as the single primary ingestion path for both microphone and uploaded files.

Changes:

- Let `POST /api/sessions` accept a `sourceType` of `microphone` or `upload`.
- Preserve uploaded chunks under the session `chunks/` directory as WAV files.
- Keep `/api/transcriptions` upload ffmpeg behavior as optional fallback only.
- Update error text so missing ffmpeg is not presented as a primary setup requirement.
- Keep local-only CORS behavior by default, but allow a configurable list of additional local origins.

The server should continue binding to loopback by default.

### Python Service

The Python service should transcribe WAV chunks the same way it transcribes WebM microphone chunks. Faster-whisper remains the runtime transcription engine.

Diarization should be opt-in:

- default transcription requests should disable diarization unless the user explicitly enables speaker labels;
- the health endpoint should report diarization availability without making normal transcription depend on pyannote;
- missing diarization dependencies must not block model loading, upload transcription, or live transcription;
- Windows FFmpeg DLL discovery should be limited to explicit optional diarization setup.

### Configuration

Add or clarify configuration for:

- `MEETINGCPU_DATA_DIR`: local session data;
- `MEETINGCPU_MODELS_DIR`: faster-whisper model cache;
- `MEETINGCPU_TMP_DIR`: upload/temp working files;
- `MEETINGCPU_SERVER_PORT`: Node API port;
- `MEETINGCPU_WEB_PORT`: Vite port;
- `MEETINGCPU_WHISPER_PORT`: Python service port;
- `MEETINGCPU_ALLOWED_ORIGINS`: optional extra local origins;
- `MEETINGCPU_ENABLE_FFMPEG_UPLOAD_FALLBACK`: opt-in server ffmpeg upload fallback;
- `MEETINGCPU_ENABLE_DIARIZATION`: opt-in speaker labels.

Defaults should prefer user-writable local app directories on Windows instead of assuming the repository folder is the right long-term data location.

## Restricted-Machine Preflight

Add a preflight path that checks and reports:

- Node and Python executables are available;
- Python virtual environment exists or setup is needed;
- faster-whisper imports successfully;
- the selected model is available locally;
- data/model/temp directories are writable;
- required local ports are available or configured;
- the Python service is reachable;
- browser supports file upload decoding;
- browser supports live microphone recording;
- browser supports session events;
- diarization is disabled, available, or unavailable with reason;
- optional ffmpeg fallback is disabled, available, or unavailable.

Preflight should produce plain, actionable messages rather than stack traces. It should distinguish:

- required blockers for all transcription;
- blockers only for live microphone recording;
- blockers only for uploaded-file decoding;
- optional feature blockers.

## Setup and Offline Behavior

Setup should be more explicit and less surprising on restricted machines.

Recommended behavior:

- keep `npm.cmd run dev` documented as the locked-down Windows command;
- make first-time Python/model setup an explicit command or clearly documented postinstall step;
- support using pre-downloaded model folders under `MEETINGCPU_MODELS_DIR`;
- document proxy and custom CA environment variables for pip/Hugging Face workflows;
- document offline wheel/model cache preparation as the preferred corporate setup path;
- avoid treating diarization download as part of normal setup.

## Error Handling

Failure behavior should preserve work:

- upload decoding failure should occur before a server session is created when possible;
- upload chunk upload failure should leave saved chunks and metadata;
- upload finalization should produce partial transcripts when at least one chunk transcribed successfully;
- missing optional ffmpeg should only affect explicit fallback mode;
- missing diarization should fall back to transcription without speaker labels;
- startup should show capability status instead of crashing the UI when browser APIs are missing.

## Testing

Implementation should include:

- browser upload chunker tests for WAV encoding, chunk timing, overlap metadata, unsupported decode errors, and mono/stereo input;
- frontend tests proving uploaded files use `createSession`, `uploadSessionChunk`, and `finalizeSession` rather than `transcribeAudio`;
- server route tests for upload `sourceType` sessions and optional ffmpeg fallback gating;
- config tests for data/model/temp directories, port overrides, and allowed origins;
- Python tests proving diarization defaults do not load pyannote or require ffmpeg;
- setup/preflight tests for clear required vs optional blocker messages;
- full verification with `npm test` and `npm run build`.

## Acceptance Criteria

- Uploaded audio can be transcribed on a machine with no `FFMPEG_PATH` and no `ffmpeg` on `PATH`, assuming the browser can decode the file.
- Live microphone transcription still works through the existing chunk-session flow.
- Missing diarization dependencies do not block transcription.
- The app reports restricted-machine blockers clearly.
- Local session data defaults to a user-writable location or is clearly overrideable.
- Ports and allowed local origins are configurable.
- Existing tests pass, and new tests cover restricted-machine upload behavior.
