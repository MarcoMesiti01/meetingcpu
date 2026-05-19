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

## Models

The app exposes `tiny`, `base`, `small`, `medium`, `large-v3-turbo`, and `distil-large-v3`. `small` is the default CPU-friendly model. Larger models may be slow or fail on memory-limited laptops.

## Saved Sessions

Recordings and transcripts are saved under `data/sessions/`. This directory is intentionally ignored by git.

## Verification

Run the automated checks:

```bash
npm test
npm run build
```

Start the local app:

```bash
npm run dev
```

Open the printed Vite URL, record a short microphone clip, stop recording, and confirm that a session folder appears under `data/sessions/` with the original recording and transcript files.

If these commands fail because local dependencies are missing, run `npm install` first. Installation needs network access for JavaScript dependencies, Python dependencies, and the model download; after dependencies and models are present, recording and transcription are intended to run locally/offline.
