import { type ChangeEvent, useEffect, useMemo, useState } from "react";
import { type ModelOption, type createApiClient } from "./api/client";

type Status = "loading" | "ready" | "recording" | "transcribing" | "complete" | "error";
type SourceType = "microphone" | "upload";

interface TranscriptionResult {
  sessionPath?: string;
  transcript?: {
    text?: string;
  };
  text?: string;
}

export type AppApi = Pick<ReturnType<typeof createApiClient>, "getModels" | "transcribeAudio">;

export interface AppRecorder {
  start(): Promise<void>;
  stop(): Promise<Blob>;
}

interface AppProps {
  api: AppApi;
  recorder: AppRecorder;
}

export default function App({ api, recorder }: AppProps) {
  const [status, setStatus] = useState<Status>("loading");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelId, setModelId] = useState("");
  const [title, setTitle] = useState("Untitled meeting");
  const [error, setError] = useState("");
  const [transcript, setTranscript] = useState("");
  const [sessionPath, setSessionPath] = useState("");

  useEffect(() => {
    let isActive = true;

    async function loadModels() {
      try {
        const response = await api.getModels();
        if (!isActive) return;

        setModels(response.models);
        setModelId(response.defaultModelId || response.models[0]?.id || "");
        setStatus("ready");
      } catch (loadError) {
        if (!isActive) return;
        setError(getErrorMessage(loadError, "Could not load model options."));
        setStatus("error");
      }
    }

    loadModels();

    return () => {
      isActive = false;
    };
  }, [api]);

  const selectedModel = useMemo(
    () => models.find((model) => model.id === modelId),
    [modelId, models]
  );
  const canStartRecording = status === "ready" || status === "complete" || status === "error";
  const canUpload = Boolean(modelId) && status !== "loading" && status !== "recording" && status !== "transcribing";

  async function handleStartRecording() {
    clearResult();
    setStatus("recording");

    try {
      await recorder.start();
    } catch (startError) {
      setError(getErrorMessage(startError, "Could not start recording."));
      setStatus("error");
    }
  }

  async function handleStopAndTranscribe() {
    setError("");
    setStatus("transcribing");

    try {
      const audio = await recorder.stop();
      await transcribe(audio, createRecordingFileName(), "microphone");
    } catch (stopError) {
      setError(getErrorMessage(stopError, "Could not transcribe recording."));
      setStatus("error");
    }
  }

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    clearResult();
    setStatus("transcribing");

    try {
      await transcribe(file, file.name || "upload.webm", "upload");
    } catch (uploadError) {
      setError(getErrorMessage(uploadError, "Could not transcribe upload."));
      setStatus("error");
    }
  }

  async function transcribe(audio: Blob, fileName: string, sourceType: SourceType) {
    const result = await api.transcribeAudio({
      audio,
      fileName,
      modelId,
      sourceType,
      title: title.trim() || "Untitled meeting"
    }) as TranscriptionResult;

    setTranscript(result.transcript?.text || result.text || "");
    setSessionPath(result.sessionPath || "");
    setStatus("complete");
  }

  function clearResult() {
    setError("");
    setTranscript("");
    setSessionPath("");
  }

  return (
    <main className="app-shell">
      <section className="workspace" aria-labelledby="app-title">
        <header className="topbar">
          <div>
            <p className="eyebrow">Local transcription</p>
            <h1 id="app-title">Local Meeting Transcription</h1>
          </div>
          <span className={`status-pill status-${status}`}>{formatStatus(status)}</span>
        </header>

        <div className="control-grid">
          <label className="field">
            <span>Meeting title</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Weekly planning"
              disabled={status === "recording" || status === "transcribing"}
            />
          </label>

          <label className="field">
            <span>Model</span>
            <select
              aria-label="Model"
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              disabled={status === "loading" || status === "recording" || status === "transcribing"}
            >
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}{model.recommended ? " (recommended)" : ""}
                </option>
              ))}
            </select>
          </label>
        </div>

        {selectedModel?.warning ? (
          <p className="model-warning" role="note">{selectedModel.warning}</p>
        ) : null}

        <div className="action-row" aria-label="Recording controls">
          <button type="button" className="primary-action" onClick={handleStartRecording} disabled={!canStartRecording || !modelId}>
            Start recording
          </button>
          <button type="button" className="secondary-action" onClick={handleStopAndTranscribe} disabled={status !== "recording"}>
            Stop and transcribe
          </button>
        </div>

        <div className="upload-panel">
          <div>
            <h2>Upload audio</h2>
            <p>Use an existing recording instead of the microphone.</p>
          </div>
          <label className={`file-control ${!canUpload ? "is-disabled" : ""}`}>
            <span>Choose file</span>
            <input
              type="file"
              accept="audio/*,.m4a,.mp3,.wav,.webm"
              onChange={handleUpload}
              disabled={!canUpload}
            />
          </label>
        </div>

        {error ? <p className="error-message" role="alert">{error}</p> : null}

        <section className="result-panel" aria-label="Transcription result">
          <div className="result-header">
            <h2>Transcript</h2>
            {sessionPath ? <span>Saved in: {sessionPath}</span> : null}
          </div>
          <div className="transcript-box">
            {status === "loading" ? "Loading local models..." : null}
            {status === "recording" ? "Recording from microphone..." : null}
            {status === "transcribing" ? "Transcribing audio..." : null}
            {status !== "loading" && status !== "recording" && status !== "transcribing"
              ? transcript || "No transcript yet."
              : null}
          </div>
        </section>
      </section>
    </main>
  );
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

function createRecordingFileName() {
  return `recording-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
}

function formatStatus(status: Status) {
  switch (status) {
    case "loading":
      return "Loading";
    case "ready":
      return "Ready";
    case "recording":
      return "Recording";
    case "transcribing":
      return "Transcribing";
    case "complete":
      return "Complete";
    case "error":
      return "Needs attention";
  }
}
