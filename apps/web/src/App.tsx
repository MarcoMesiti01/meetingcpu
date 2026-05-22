import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type FinalizeSessionResponse,
  type ModelOption,
  type SessionEvent,
  type SessionEventConnection,
  type TranscriptSegment,
  type createApiClient
} from "./api/client";
import type { RecordedAudioChunk, StartChunkedRecordingOptions } from "./audio/recorder";

type Status = "loading" | "ready" | "starting" | "recording" | "finalizing" | "transcribing" | "complete" | "error";
type SourceType = "microphone" | "upload";

interface TranscriptionResult {
  sessionPath?: string;
  transcript?: {
    text?: string;
  };
  text?: string;
}

interface SessionPaths {
  sessionPath?: string;
  inProgressTranscriptPath?: string;
  transcriptPath?: string;
  transcriptJsonPath?: string;
}

interface TranscriptGroup {
  id: string;
  speaker: string;
  text: string;
  timestamp?: string;
}

export type AppApi = Pick<
  ReturnType<typeof createApiClient>,
  "getModels" | "transcribeAudio" | "createSession" | "uploadSessionChunk" | "finalizeSession" | "subscribeToSessionEvents"
>;

export interface AppRecorder {
  start(): Promise<void>;
  startChunked(options: StartChunkedRecordingOptions): Promise<void>;
  stop(): Promise<Blob>;
}

export default function App({ api, recorder }: AppProps) {
  const [status, setStatus] = useState<Status>("loading");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelId, setModelId] = useState("");
  const [title, setTitle] = useState("Untitled meeting");
  const [error, setError] = useState("");
  const [modelLoadError, setModelLoadError] = useState(false);
  const [uploadTranscript, setUploadTranscript] = useState("");
  const [transcriptGroups, setTranscriptGroups] = useState<TranscriptGroup[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [sessionPaths, setSessionPaths] = useState<SessionPaths>({});
  const [savedChunkCount, setSavedChunkCount] = useState(0);
  const [transcribedChunkCount, setTranscribedChunkCount] = useState(0);
  const [failedChunkCount, setFailedChunkCount] = useState(0);
  const [localRecordingSize, setLocalRecordingSize] = useState(0);
  const [diarizationStatus, setDiarizationStatus] = useState("Waiting for speaker labels");
  const eventConnectionRef = useRef<SessionEventConnection | null>(null);
  const activeSessionIdRef = useRef("");
  const startInProgressRef = useRef(false);
  const clientChunkUploadFailedRef = useRef(false);
  const transcribedChunkIndexesRef = useRef<Set<number>>(new Set());
  const failedChunkIndexesRef = useRef<Set<number>>(new Set());

  const loadModels = useCallback(async (isActive: () => boolean = () => true) => {
    setError("");
    setModelLoadError(false);
    setStatus("loading");

    try {
      const response = await api.getModels();
      if (!isActive()) return;

      const nextModels = response.models ?? [];
      if (nextModels.length === 0) {
        setModels([]);
        setModelId("");
        setError("No local transcription models were found. Check that the server can see your model files, then reload models.");
        setModelLoadError(true);
        setStatus("error");
        return;
      }

      setModels(nextModels);
      setModelId(response.defaultModelId || nextModels[0].id);
      setStatus("ready");
    } catch (loadError) {
      if (!isActive()) return;
      setError(getErrorMessage(loadError, "Could not load model options. Check the local server, then reload models."));
      setModelLoadError(true);
      setStatus("error");
    }
  }, [api]);

  useEffect(() => {
    let isActive = true;
    loadModels(() => isActive);

    return () => {
      isActive = false;
      eventConnectionRef.current?.close();
      eventConnectionRef.current = null;
      activeSessionIdRef.current = "";
    };
  }, [loadModels]);

  const selectedModel = useMemo(
    () => models.find((model) => model.id === modelId),
    [modelId, models]
  );
  const activeTranscriptText = uploadTranscript || transcriptGroups.map((group) => group.text).join("\n");
  const canStartRecording = Boolean(modelId) && !modelLoadError && !sessionId && !startInProgressRef.current && (status === "ready" || status === "complete" || status === "error");
  const canStopRecording = Boolean(sessionId) && (status === "recording" || status === "error");
  const canUpload = Boolean(modelId) && !modelLoadError && !sessionId && status !== "loading" && status !== "starting" && status !== "recording" && status !== "finalizing" && status !== "transcribing";

  async function handleStartRecording() {
    if (startInProgressRef.current) return;
    startInProgressRef.current = true;
    if (!Boolean(modelId) || modelLoadError || sessionId || !(status === "ready" || status === "complete" || status === "error")) {
      startInProgressRef.current = false;
      return;
    }

    setError("");
    setModelLoadError(false);
    setStatus("starting");
    clientChunkUploadFailedRef.current = false;

    try {
      const created = await api.createSession({
        title: title.trim() || "Untitled meeting",
        modelId,
        diarization: true
      });
      activeSessionIdRef.current = created.sessionId;
      setSessionId(created.sessionId);
      setSessionPaths({
        sessionPath: created.sessionPath,
        inProgressTranscriptPath: created.inProgressTranscriptPath
      });
      const connection = api.subscribeToSessionEvents(created.sessionId, {
        onEvent: handleSessionEvent,
        onError: (streamError) => {
          setError(getErrorMessage(streamError, "Session event stream failed."));
          setStatus("error");
        }
      });
      eventConnectionRef.current = connection;

      await recorder.startChunked({
        onChunk: (chunk) => uploadChunk(created.sessionId, chunk)
      });

      clearResult();
      activeSessionIdRef.current = created.sessionId;
      setSessionId(created.sessionId);
      setSessionPaths({
        sessionPath: created.sessionPath,
        inProgressTranscriptPath: created.inProgressTranscriptPath
      });
      setStatus("recording");
    } catch (startError) {
      eventConnectionRef.current?.close();
      eventConnectionRef.current = null;
      activeSessionIdRef.current = "";
      setSessionId("");
      setError(getErrorMessage(startError, "Could not start live recording session."));
      setStatus("error");
    } finally {
      startInProgressRef.current = false;
    }
  }

  async function handleStopAndFinalize() {
    if (!sessionId) return;

    setError("");
    setStatus("finalizing");
    let stopErrorMessage = "";

    try {
      const preservedRecording = await recorder.stop();
      setLocalRecordingSize(preservedRecording.size);
    } catch (stopError) {
      stopErrorMessage = getErrorMessage(stopError, "Could not stop live recording cleanly.");
    }

    if (clientChunkUploadFailedRef.current) {
      eventConnectionRef.current?.close();
      eventConnectionRef.current = null;
      activeSessionIdRef.current = "";
      setSessionId("");
      setError(stopErrorMessage || "A microphone chunk upload failed. The session was not finalized because audio may be missing.");
      setStatus("error");
      return;
    }

    try {
      const finalized = await api.finalizeSession(sessionId);
      applyFinalizedSession(finalized);
      eventConnectionRef.current?.close();
      eventConnectionRef.current = null;
      activeSessionIdRef.current = "";
      setSessionId("");
      if (stopErrorMessage) {
        setError(stopErrorMessage);
        setStatus("error");
      } else {
        setStatus(finalized.partial ? "error" : "complete");
      }
    } catch (finalizeError) {
      setError(getErrorMessage(finalizeError, "Could not finalize live transcription session."));
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

    setUploadTranscript(result.transcript?.text || result.text || "");
    setSessionPaths({ sessionPath: result.sessionPath || "" });
    setStatus("complete");
  }

  async function uploadChunk(activeSessionId: string, chunk: RecordedAudioChunk) {
    try {
      await api.uploadSessionChunk({
        sessionId: activeSessionId,
        audio: chunk.blob,
        fileName: chunk.fileName,
        chunkIndex: chunk.chunkIndex,
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds,
        overlapSeconds: chunk.overlapSeconds,
        modelId,
        sourceType: "microphone",
        mimeType: chunk.mimeType
      });
    } catch (chunkError) {
      clientChunkUploadFailedRef.current = true;
      setError(getErrorMessage(chunkError, `Chunk ${chunk.chunkIndex} upload failed.`));
      setStatus("error");
      throw chunkError;
    }
  }

  function handleSessionEvent(event: SessionEvent) {
    if (event.sessionId !== activeSessionIdRef.current) return;

    if (event.type === "chunk-saved") {
      setSavedChunkCount((count) => Math.max(count, event.chunkIndex));
      return;
    }

    if (event.type === "chunk-transcribed") {
      if (transcribedChunkIndexesRef.current.has(event.chunkIndex)) return;
      transcribedChunkIndexesRef.current.add(event.chunkIndex);
      setTranscribedChunkCount((count) => Math.max(count, event.chunkIndex));
      setDiarizationStatus(formatDiarizationStatus(event.diarization));
      setTranscriptGroups((groups) => {
        if (event.transcriptSegments && event.transcriptSegments.length > 0) {
          return transcriptGroupsFromSegments(event.transcriptSegments, `transcript-${event.chunkIndex}`);
        }
        if (event.acceptedSegments && event.acceptedSegments.length > 0) {
          return mergeTranscriptSegmentGroups(groups, event.acceptedSegments, `chunk-${event.chunkIndex}`);
        }
        return mergeTranscriptGroups(groups, event.text, event.chunkIndex);
      });
      return;
    }

    if (event.type === "chunk-failed") {
      if (failedChunkIndexesRef.current.has(event.chunkIndex)) return;
      failedChunkIndexesRef.current.add(event.chunkIndex);
      setFailedChunkCount((count) => count + 1);
      setError(`Chunk ${event.chunkIndex} failed: ${event.message}`);
      setStatus("error");
      return;
    }

    if (event.type === "session-finalized") {
      setSessionPaths((paths) => ({
        ...paths,
        transcriptPath: event.transcriptPath
      }));
    }
  }

  function applyFinalizedSession(finalized: FinalizeSessionResponse) {
    setSessionPaths((paths) => ({
      ...paths,
      transcriptPath: finalized.transcriptPath,
      transcriptJsonPath: finalized.transcriptJsonPath
    }));
    if (finalized.partial) {
      setError("Session finalized with a partial transcript. Some chunks failed.");
    }
  }

  function clearResult() {
    setError("");
    setUploadTranscript("");
    setTranscriptGroups([]);
    setSessionPaths({});
    setSavedChunkCount(0);
    setTranscribedChunkCount(0);
    setFailedChunkCount(0);
    setLocalRecordingSize(0);
    setDiarizationStatus("Waiting for speaker labels");
    clientChunkUploadFailedRef.current = false;
    transcribedChunkIndexesRef.current.clear();
    failedChunkIndexesRef.current.clear();
  }

  return (
    <main className="app-shell">
      <section className="workspace" aria-labelledby="app-title">
        <header className="topbar">
          <div>
            <p className="eyebrow">Local transcription</p>
            <h1 id="app-title">Local Meeting Transcription</h1>
          </div>
          <span className={`status-pill status-${status}`} role="status" aria-live="polite">{formatStatus(status)}</span>
        </header>

        <section className="dashboard-grid" aria-label="Recording dashboard">
          <div className="panel control-panel">
            <div className="panel-heading">
              <h2>Session controls</h2>
              <span>{selectedModel?.label || "No model selected"}</span>
            </div>

            <div className="control-grid">
              <label className="field">
                <span>Meeting title</span>
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Weekly planning"
                  disabled={status === "starting" || status === "recording" || status === "finalizing" || status === "transcribing"}
                />
              </label>

              <label className="field">
                <span>Model</span>
                <select
                  aria-label="Model"
                  value={modelId}
                  onChange={(event) => setModelId(event.target.value)}
                  disabled={status === "loading" || status === "starting" || status === "recording" || status === "finalizing" || status === "transcribing"}
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

            <div className="action-row" role="group" aria-label="Recording controls">
              <button type="button" className="primary-action" onClick={handleStartRecording} disabled={!canStartRecording}>
                Start recording
              </button>
              <button type="button" className="secondary-action" onClick={handleStopAndFinalize} disabled={!canStopRecording}>
                Stop and finalize
              </button>
              {modelLoadError ? (
                <button type="button" className="secondary-action" onClick={() => void loadModels()} disabled={status === "loading"}>
                  Reload models
                </button>
              ) : null}
            </div>
          </div>

          <aside className="panel metrics-panel" aria-label="Status metrics">
            <Metric label="Session" value={sessionId || "Not started"} />
            <Metric label="Chunks saved" value={String(savedChunkCount)} />
            <Metric label="Chunks transcribed" value={String(transcribedChunkCount)} />
            <Metric label="Chunk failures" value={String(failedChunkCount)} />
            <Metric label="Speaker labels" value={diarizationStatus} />
          </aside>
        </section>

        <section className="panel upload-panel">
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
        </section>

        {error ? <p className="error-message" role="alert">{error}</p> : null}

        <section className="panel result-panel" aria-label="Transcription result">
          <div className="result-header">
            <div>
              <h2>Transcript workspace</h2>
              <p>{transcriptSubtitle(status, activeTranscriptText)}</p>
            </div>
          </div>

          <div className="transcript-box" aria-live="polite">
            {renderTranscript(status, transcriptGroups, uploadTranscript)}
          </div>
        </section>

        <section className="panel session-panel" aria-label="Saved files">
          <h2>Saved files</h2>
          <div className="path-list">
            {sessionPaths.sessionPath ? <span>Session: {sessionPaths.sessionPath}</span> : null}
            {sessionPaths.inProgressTranscriptPath ? <span>In progress: {sessionPaths.inProgressTranscriptPath}</span> : null}
            {sessionPaths.transcriptPath ? <span>Final transcript: {sessionPaths.transcriptPath}</span> : null}
            {sessionPaths.transcriptJsonPath ? <span>Transcript JSON: {sessionPaths.transcriptJsonPath}</span> : null}
            {localRecordingSize > 0 ? <span>Full local recording: preserved in browser memory ({formatBytes(localRecordingSize)})</span> : null}
            {!sessionPaths.sessionPath && !sessionPaths.inProgressTranscriptPath && !sessionPaths.transcriptPath && localRecordingSize === 0 ? (
              <span>No saved files yet.</span>
            ) : null}
          </div>
        </section>
      </section>
    </main>
  );
}

interface AppProps {
  api: AppApi;
  recorder: AppRecorder;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function renderTranscript(status: Status, groups: TranscriptGroup[], uploadTranscript: string) {
  if (status === "loading") return "Loading local models...";
  if (status === "starting") return "Starting live recording session...";
  if (status === "recording" && groups.length === 0) return "Recording from microphone. Transcript segments will appear as chunks complete.";
  if (status === "finalizing") return groups.length > 0 ? groups.map(renderTranscriptGroup) : "Finalizing saved chunks...";
  if (status === "transcribing") return "Transcribing uploaded audio...";
  if (groups.length > 0) return groups.map(renderTranscriptGroup);
  return uploadTranscript || "No transcript yet.";
}

function renderTranscriptGroup(group: TranscriptGroup) {
  return (
    <article className="transcript-segment" key={group.id}>
      <div>
        <strong>{group.speaker}</strong>
        {group.timestamp ? <span>{group.timestamp}</span> : null}
      </div>
      <p>{group.text}</p>
    </article>
  );
}

function mergeTranscriptGroups(groups: TranscriptGroup[], text: string, chunkIndex: number): TranscriptGroup[] {
  const parsedLines = parseTranscriptText(text, chunkIndex);
  if (parsedLines.length === 0) return groups;

  const nextGroups = [...groups];
  for (const line of parsedLines) {
    const previous = nextGroups.at(-1);
    if (previous && previous.speaker === line.speaker) {
      nextGroups[nextGroups.length - 1] = {
        ...previous,
        text: `${previous.text}\n${line.text}`
      };
    } else {
      nextGroups.push(line);
    }
  }
  return nextGroups;
}

function mergeTranscriptSegmentGroups(
  groups: TranscriptGroup[],
  segments: TranscriptSegment[],
  idPrefix: string
): TranscriptGroup[] {
  const segmentGroups = transcriptGroupsFromSegments(segments, idPrefix);
  if (segmentGroups.length === 0) return groups;

  const nextGroups = [...groups];
  for (const group of segmentGroups) {
    const previous = nextGroups.at(-1);
    if (previous && previous.speaker === group.speaker) {
      nextGroups[nextGroups.length - 1] = {
        ...previous,
        text: `${previous.text}\n${group.text}`
      };
    } else {
      nextGroups.push(group);
    }
  }
  return nextGroups;
}

function transcriptGroupsFromSegments(segments: TranscriptSegment[], idPrefix: string): TranscriptGroup[] {
  return [...segments]
    .sort((left, right) => left.start - right.start || left.end - right.end)
    .map((segment, index) => ({
      id: `${idPrefix}-${index}-${segment.start}-${segment.end}`,
      speaker: normalizeSpeaker(segment.speaker),
      timestamp: formatSegmentTimestamp(segment.start),
      text: segment.text.trim()
    }))
    .filter((group) => group.text.length > 0);
}

function parseTranscriptText(text: string, chunkIndex: number): TranscriptGroup[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const timestampMatch = line.match(/^\[(?<timestamp>[^\]]+)\]\s*(?<rest>.*)$/);
      const timestamp = timestampMatch?.groups?.timestamp;
      const body = timestampMatch?.groups?.rest ?? line;
      const speakerMatch = body.match(/^(?<speaker>Speaker\s+\d+):\s*(?<text>.*)$/i);
      const speaker = normalizeSpeaker(speakerMatch?.groups?.speaker);
      return {
        id: `${chunkIndex}-${index}-${body}`,
        speaker,
        timestamp,
        text: speakerMatch?.groups?.text?.trim() || body.trim()
      };
    });
}

function normalizeSpeaker(speaker?: string) {
  if (!speaker) return "Speaker 1";
  const match = speaker.match(/speaker\s+(\d+)/i);
  return match ? `Speaker ${match[1]}` : speaker;
}

function formatSegmentTimestamp(seconds: number) {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  return [hours, minutes, remainingSeconds].map((part) => part.toString().padStart(2, "0")).join(":");
}

function formatDiarizationStatus(diarization: { available: boolean; enabled: boolean; error?: string }) {
  if (diarization.enabled && diarization.available) return "Available";
  if (diarization.error) return diarization.error;
  if (diarization.enabled) return "Fallback labels";
  return "Not enabled";
}

function transcriptSubtitle(status: Status, text: string) {
  if (status === "recording") return "Live chunk transcript";
  if (status === "finalizing") return "Assembling final transcript from saved chunks";
  if (text) return "Final transcript";
  return "Waiting for audio";
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatStatus(status: Status) {
  switch (status) {
    case "loading":
      return "Loading";
    case "ready":
      return "Ready";
    case "starting":
      return "Starting";
    case "recording":
      return "Recording";
    case "finalizing":
      return "Finalizing";
    case "transcribing":
      return "Transcribing";
    case "complete":
      return "Complete";
    case "error":
      return "Needs attention";
  }
}
