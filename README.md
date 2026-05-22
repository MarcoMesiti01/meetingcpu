# meetingcpu

A local-first meeting transcription tool for CPU-centered laptops.

## Goal

The app records microphone audio in the browser, saves the recording locally, and transcribes it locally with faster-whisper. After installation and model download, transcription is designed to run offline.

## Development Flow

```bash
npm install
npm run dev
```

`npm install` installs JavaScript dependencies, creates a local Python virtual environment, installs the faster-whisper service dependencies, and downloads the default `small` model.

`npm run dev` starts the browser app, the local Node API, and the local Python transcription service.

## Live Chunking

Microphone recordings are processed locally in 30-second chunks with a 5-second overlap. After each completed chunk is transcribed, the app saves `transcript.in-progress.txt` in the session folder so long meetings have a readable partial transcript while recording continues.

When recording stops, the final transcript is assembled from the saved chunk results. The app does not retranscribe the full microphone recording at the end. Session chunk files are saved under `apps/server/data/sessions/<id>/chunks` by default. Set `MEETINGCPU_DATA_DIR` to use a different local data directory.

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

Speaker diarization uses `pyannote.audio` and is optional. Before the first diarization download, accept the Hugging Face terms for `pyannote/speaker-diarization-3.1` and `pyannote/segmentation-3.0`, then run these commands in PowerShell:

```powershell
npm.cmd install
$env:HF_TOKEN="hf_your_token_here"
npm.cmd run download:diarization
npm.cmd run dev
```

The download step needs network access and a Hugging Face token with access to the accepted pyannote models. After the files are cached locally, diarization runs locally/offline from cache.

If diarization is unavailable, missing, or not downloaded, transcription still runs; speaker separation is unavailable and any labels may be generic fallback labels. Offline speaker separation requires running the diarization download first. CPU laptops may find diarization slower than transcription.

## Saved Sessions

Recordings and transcripts are saved under `apps/server/data/sessions/` by default. This directory is intentionally ignored by git. Set `MEETINGCPU_DATA_DIR` before starting the server to use another local data directory.

Uploaded audio is also chunked locally before transcription when `FFMPEG_PATH` is set or `ffmpeg` is available on `PATH`. If ffmpeg is unavailable, the app returns a controlled requirement error instead of silently falling back to a different path.

On Windows, install ffmpeg and make sure `ffmpeg.exe` is available on `PATH`, or set `FFMPEG_PATH` to the full executable path:

```powershell
$env:FFMPEG_PATH="C:\Program Files\ffmpeg\bin\ffmpeg.exe"
```

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

Open the printed Vite URL, record a short microphone clip, stop recording, and confirm that a session folder appears under `apps/server/data/sessions/` with `chunks/`, `transcript.in-progress.txt`, and the final transcript files.

If these commands fail because local dependencies are missing, run `npm install` first. Installation needs network access for JavaScript dependencies, Python dependencies, and the model download; after dependencies and models are present, recording and transcription are intended to run locally/offline.
