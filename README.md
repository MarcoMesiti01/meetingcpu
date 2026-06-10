# meetingcpu

A local-first meeting transcription tool for CPU-centered laptops.

## Goal

The app records microphone audio in the browser, saves local session artifacts, and transcribes locally with faster-whisper. After installation and model download, transcription is designed to run offline.

## Prerequisites

- Node.js 20 or newer
- Python 3.9 or newer
- Network access for the first install and model downloads
- Optional: ffmpeg only for the disabled-by-default server upload fallback
- Optional: Hugging Face token with accepted pyannote terms for opt-in speaker labels

## Development Flow

```bash
npm install
npm run dev
```

In PowerShell environments where `npm.ps1` is blocked by execution policy, use `npm.cmd install` and `npm.cmd run dev`.

`npm install` installs JavaScript dependencies, creates a local Python virtual environment, installs the faster-whisper service dependencies, and downloads the default `small` model.

`npm run dev` starts the browser app, the local Node API, and the local Python transcription service.

For restricted machines where install-time Python setup or model downloads are blocked, skip the postinstall step and run setup later from an approved network:

```powershell
$env:MEETINGCPU_SKIP_PYTHON_SETUP="true"
npm.cmd install
Remove-Item Env:\MEETINGCPU_SKIP_PYTHON_SETUP
npm.cmd run download:model -- small
```

If the default ports are blocked, set local alternatives before starting the app:

```powershell
$env:MEETINGCPU_WEB_PORT="6173"
$env:MEETINGCPU_SERVER_PORT="6174"
$env:MEETINGCPU_WHISPER_PORT="6175"
npm.cmd run dev
```

## Live Chunking

Microphone recordings are processed locally in 30-second chunks with a 5-second overlap. After each completed chunk is transcribed, the app saves `transcript.in-progress.txt` in the session folder so long meetings have a readable partial transcript while recording continues.

When recording stops, the final transcript is assembled from the saved chunk results. The app does not retranscribe the full microphone recording at the end. On Windows, session chunk files are saved under `%LOCALAPPDATA%\meetingcpu\data\sessions\<id>\chunks` by default. Set `MEETINGCPU_DATA_DIR` to use a different local data directory.

## Models

The app exposes `tiny`, `base`, `small`, `medium`, `large-v3-turbo`, and `distil-large-v3`. `small` is the default CPU-friendly model and is the only model downloaded by `npm install`. Larger models may be slow or fail on memory-limited laptops.

Download any additional selectable model before using it offline:

```bash
npm run download:model -- medium
```

You can pass more than one model name:

```bash
npm run download:model -- tiny base distil-large-v3
```

The download step needs network access. After a model is present under `models/`, that model can be used offline.

## Optional Speaker Labels

Speaker diarization uses `pyannote.audio` and is optional. It is disabled by default for reliability on restricted laptops; enable speaker labels in the UI only after the local diarization setup works. Before the first diarization download, accept the Hugging Face conditions for [`pyannote/speaker-diarization-community-1`](https://huggingface.co/pyannote/speaker-diarization-community-1). Store the access token in the ignored `.env` file:

```powershell
npm.cmd install
Set-Content -Path .env -Value 'HF_TOKEN=hf_your_token_here'
npm.cmd run download:diarization
npm.cmd run dev
```

Alternatively, for one terminal session, set `$env:HF_TOKEN="hf_your_token_here"` before the download command. The download step needs network access and a Hugging Face token with access to the accepted model. After the files are saved locally, diarization runs locally/offline from `models/diarization/`.

On Windows, `pyannote.audio` 4 also needs a full-shared FFmpeg installation for audio decoding, with FFmpeg DLL files available alongside `ffmpeg.exe` or on `PATH`. A static FFmpeg build can support uploaded-audio conversion but is not enough for pyannote speaker labels. Install the shared build, then start a new terminal before running the download command:

```powershell
winget install --id Gyan.FFmpeg.Shared --exact --source winget
```

If diarization is unavailable, missing, or not downloaded, transcription still runs; speaker separation is unavailable and any labels may be generic fallback labels. Offline speaker separation requires running the diarization download first. CPU laptops may find diarization slower than transcription.

## Saved Sessions

Live microphone sessions save chunk audio files, in-progress transcripts, and final transcript files under `%LOCALAPPDATA%\meetingcpu\data\sessions\` on Windows by default. On non-Windows systems without an explicit data directory, the fallback is `data/sessions/` from the server working directory. The continuous full recording is available in the browser when recording stops, but it is not saved under the server session folder. Set `MEETINGCPU_DATA_DIR` before starting the server to use another local data directory.

Uploaded audio is chunked in the browser by default. The browser decodes the file, creates WAV chunks, and sends them through the same saved-session pipeline used by microphone recording. This path does not require `FFMPEG_PATH`, global `PATH` changes, or a server-side ffmpeg install.

The legacy server-side upload splitter is disabled by default. Enable it only if browser decoding is not enough and ffmpeg is approved on the machine:

```powershell
$env:MEETINGCPU_ENABLE_FFMPEG_UPLOAD_FALLBACK="true"
$env:FFMPEG_PATH="C:\Program Files\ffmpeg\bin\ffmpeg.exe"
```

If the browser cannot decode an uploaded file, convert it to WAV, MP3, M4A, or WebM on an approved machine, or enable the fallback above after making ffmpeg available.

## Verification

Run the automated checks:

```bash
npm test
npm run build
```

In PowerShell environments where `npm.ps1` is blocked by execution policy, use `npm.cmd test` and `npm.cmd run build`.

Start the local app:

```bash
npm run dev
```

The PowerShell equivalent is `npm.cmd run dev`.

Open the printed Vite URL, record a short microphone clip, stop recording, and confirm that a session folder appears under the configured data directory with `chunks/`, `transcript.in-progress.txt`, and the final transcript files.

If these commands fail because local dependencies are missing, run `npm install` first. Installation needs network access for JavaScript dependencies, Python dependencies, and the model download; after dependencies and models are present, recording and transcription are intended to run locally/offline.
