# Local Meeting Transcription Design

## Purpose

Build a local-first tool for CPU-centered laptops that records meeting audio from the microphone, saves the recording locally, and transcribes it locally with faster-whisper. The initial user experience can be developer-oriented: clone the repository, run `npm install`, then run `npm run dev` and open the browser app.

The system must not depend on remote services after installation. Internet access is allowed during installation to install packages and download transcription models. Runtime transcription must work offline when the selected model is already present locally.

## Scope

The MVP focuses on microphone recording followed by transcription after the recording stops. File upload transcription is supported if it stays cheap because it can reuse the same local transcription pipeline. If upload support adds meaningful complexity, the implementation can keep the backend boundary ready and defer the visible upload control.

Near-live transcription is out of scope for the first version. A provisional live preview can be considered later, but the best first result for CPU laptops is record-first, then transcribe with stable audio context.

## Architecture

The project will be a local-first monorepo driven by npm.

### Browser Frontend

The frontend is a Vite browser app. It handles microphone permission, recording controls, audio upload controls if included, model selection, transcription status, transcript display, and export actions.

The frontend captures microphone audio locally through browser APIs. It should keep recording state isolated behind a small module so tests can cover the app flow without depending directly on browser media APIs.

### Node Orchestrator

The Node server is the app-facing backend. It owns the HTTP API used by the frontend, local session creation, recording persistence, transcript persistence, process startup checks, and communication with the Python transcription service.

The Node layer is also responsible for the developer run experience. `npm run dev` should start the frontend, Node server, and local Python transcription service together.

### Python faster-whisper Service

The Python service runs locally and uses `faster-whisper` on CPU. It exposes a narrow local API to the Node server for health checks, model availability, and transcription jobs.

The service should default to CPU-friendly settings, especially int8 compute where supported. It should avoid any remote calls during runtime. If a selected model is missing at runtime, it should return a clear local error instead of attempting an implicit online download.

### Local Storage

Recordings, uploaded files, transcripts, and metadata are stored locally under an app-controlled data directory. A session folder should be created for each meeting.

Example layout:

```text
data/sessions/
  2026-05-18-1530-local-meeting/
    recording.webm
    transcript.json
    transcript.txt
    metadata.json
```

The original recording is preserved by default. If transcription fails or is interrupted, the recording remains in the session folder with metadata that explains the failure state.

## Install And Run Flow

The target flow is:

```text
git clone <repository>
cd meetingcpu
npm install
npm run dev
```

`npm install` installs JavaScript dependencies, creates or updates the Python environment, installs Python transcription dependencies, and downloads the default model.

The first implementation can assume the machine has Node and Python installed. The setup script should detect missing Python or unsupported versions and report a clear error. It should not hide failures behind partial installs.

`npm run dev` starts all local services and prints the browser URL. The app should open in a browser tab automatically if practical, but printing the URL is acceptable for the first version.

## Model Strategy

The UI exposes several model choices instead of blocking heavier options.

Recommended model list:

- `tiny`: fastest, lowest quality
- `base`: useful fallback for weak CPUs
- `small`: recommended default for CPU quality and speed
- `medium`: higher quality but slow on many laptops
- `large-v3-turbo` or `distil-large-v3`: experimental high-quality option that may be slow or fail on memory-limited machines

The default should be `small` with CPU-friendly int8 settings. Heavier models should be labeled as slower or experimental for CPU use. If loading a model fails because of memory, missing files, or incompatible runtime settings, the API returns a structured error and suggests smaller models.

Model files are downloaded during installation. Runtime should use only local cached models.

## Transcription Flow

### Microphone Recording

1. The user starts recording in the browser.
2. The frontend captures microphone audio locally.
3. The user stops recording.
4. The frontend uploads the recorded audio to the local Node server.
5. The Node server creates a session folder and saves the recording there.
6. The Node server asks the Python service to transcribe the saved audio.
7. The Python service normalizes/converts the audio if needed and runs faster-whisper with the selected model.
8. The UI receives job status updates and then displays the final transcript.
9. The app writes transcript JSON, transcript text, and metadata into the session folder.

### File Upload

Uploaded audio files use the same persistence and transcription path as microphone recordings. The source metadata distinguishes uploaded files from microphone recordings.

### Transcript Data

The transcript data should preserve:

- full transcript text
- timestamped segments
- selected model
- language mode, with auto-detect as the default
- source type, either microphone or upload
- recording path or uploaded file path
- transcription status, timing, and error information

## Error Handling

Errors should be local and recoverable:

- If the Python service fails to start, the Node server exposes a setup/startup error to the UI.
- If a model is missing at runtime, the app reports that the model is unavailable locally.
- If a model is too heavy or fails to load, the app suggests `small`, `base`, or `tiny`.
- If audio conversion fails, the original recording remains saved and the error is recorded in metadata.
- If transcription is interrupted, the session folder remains with the last known status.

## Testing Strategy

Tests should focus on boundaries that keep the app reliable:

- model option validation and user-facing fallback messages
- session folder creation and safe file naming
- microphone recording save behavior through a testable recording abstraction
- file upload save behavior if upload support is included
- transcription request and status flow using a fake local transcription service
- transcript and metadata persistence
- frontend recording states where practical

The transcription service can be integration-tested separately with a short local audio fixture when dependencies are available. Routine application tests should not require downloading large models or running a real transcription job.

## Deferred Work

The following are intentionally deferred:

- near-live or streaming transcription
- speaker diarization
- summarization or action-item extraction
- cloud synchronization
- packaged desktop installers
- deletion policies beyond preserving recordings by default

These can be added later without changing the core local-first architecture.
