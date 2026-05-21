import "@testing-library/jest-dom/vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import App, { type AppApi, type AppRecorder } from "./App";
import type { SessionEvent, SessionEventHandlers } from "./api/client";
import type { RecordedAudioChunk } from "./audio/recorder";

describe("App", () => {
  it("loads model choices and starts ready", async () => {
    const api = createApi();
    const recorder = createRecorder();

    render(<App api={api} recorder={recorder} />);

    expect(screen.getByRole("heading", { name: "Local Meeting Transcription" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Model")).toHaveValue("small"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled());
  });

  it("records microphone audio as live chunks, finalizes the session, and does not use legacy microphone transcription", async () => {
    const user = userEvent.setup();
    let eventHandlers: SessionEventHandlers | undefined;
    const closeEvents = vi.fn();
    const api = createApi({
      createSession: vi.fn().mockResolvedValue({
        sessionId: "session-1",
        sessionPath: "C:\\recordings\\meeting-1",
        inProgressTranscriptPath: "C:\\recordings\\meeting-1\\transcript.in-progress.txt"
      }),
      subscribeToSessionEvents: vi.fn((sessionId, handlers) => {
        expect(sessionId).toBe("session-1");
        eventHandlers = handlers;
        return { close: closeEvents };
      }),
      uploadSessionChunk: vi.fn().mockResolvedValue({ sessionId: "session-1", chunkIndex: 1, status: "queued" }),
      finalizeSession: vi.fn().mockResolvedValue({
        sessionId: "session-1",
        transcriptPath: "C:\\recordings\\meeting-1\\transcript.txt",
        transcriptJsonPath: "C:\\recordings\\meeting-1\\transcript.json",
        partial: false
      })
    });
    const recorder = createRecorder();

    render(<App api={api} recorder={recorder} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start recording" }));

    await waitFor(() => {
      expect(api.createSession).toHaveBeenCalledWith({
        title: "Untitled meeting",
        modelId: "small",
        diarization: true
      });
    });
    expect(api.subscribeToSessionEvents).toHaveBeenCalledTimes(1);
    expect(recorder.startChunked).toHaveBeenCalledTimes(1);

    await recorder.emitChunk(createChunk({ text: "chunk audio" }));
    await waitFor(() => {
      expect(api.uploadSessionChunk).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "session-1",
        audio: expect.any(Blob),
        fileName: "chunk-000001.webm",
        chunkIndex: 1,
        startSeconds: 0,
        endSeconds: 30,
        overlapSeconds: 0,
        modelId: "small",
        sourceType: "microphone",
        mimeType: "audio/webm"
      }));
    });

    emitEvent(eventHandlers, {
      type: "chunk-transcribed",
      sessionId: "session-1",
      chunkIndex: 1,
      text: "[00:00:00] Speaker 1: We agreed to ship the local UI.",
      diarization: { available: true, enabled: true }
    });

    expect(await screen.findByText("Speaker 1")).toBeInTheDocument();
    expect(screen.getByText("We agreed to ship the local UI.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Stop and finalize" }));

    await waitFor(() => expect(api.finalizeSession).toHaveBeenCalledWith("session-1"));
    expect(api.transcribeAudio).not.toHaveBeenCalled();
    expect(closeEvents).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Session: C:\\recordings\\meeting-1")).toBeInTheDocument();
    expect(screen.getByText("In progress: C:\\recordings\\meeting-1\\transcript.in-progress.txt")).toBeInTheDocument();
    expect(screen.getByText("Final transcript: C:\\recordings\\meeting-1\\transcript.txt")).toBeInTheDocument();
  });

  it("shows a retry action when model loading fails and reloads models", async () => {
    const user = userEvent.setup();
    const api = createApi({
      getModels: vi.fn()
        .mockRejectedValueOnce(new Error("Whisper models unavailable."))
        .mockResolvedValueOnce({
          defaultModelId: "large",
          models: [
            { id: "large", label: "Large", recommended: true }
          ]
        })
    });

    render(<App api={api} recorder={createRecorder()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Whisper models unavailable.");
    const reloadButton = screen.getByRole("button", { name: "Reload models" });
    await user.click(reloadButton);

    await waitFor(() => expect(api.getModels).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByLabelText("Model")).toHaveValue("large"));
    expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled();
  });

  it("treats an empty model list as a retryable error", async () => {
    const api = createApi({
      getModels: vi.fn().mockResolvedValue({
        defaultModelId: "",
        models: []
      })
    });

    render(<App api={api} recorder={createRecorder()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("No local transcription models were found.");
    expect(screen.getByRole("button", { name: "Reload models" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Start recording" })).toBeDisabled();
  });

  it("keeps the previous transcript when recorder start fails", async () => {
    const user = userEvent.setup();
    const api = createApi();
    const recorder = createRecorder({
      startChunked: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("Microphone permission denied."))
    });

    render(<App api={api} recorder={recorder} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start recording" }));
    emitEvent(api.lastEventHandlers, {
      type: "chunk-transcribed",
      sessionId: "session-1",
      chunkIndex: 1,
      text: "Transcript text",
      diarization: { available: false, enabled: true, error: "No speakers detected." }
    });
    await user.click(screen.getByRole("button", { name: "Stop and finalize" }));
    expect(await screen.findByText("Transcript text")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Start recording" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Microphone permission denied."));
    expect(screen.getByText("Transcript text")).toBeInTheDocument();
  });

  it("shows an error when live chunk upload fails", async () => {
    const user = userEvent.setup();
    const api = createApi({
      uploadSessionChunk: vi.fn().mockRejectedValue(new Error("Chunk upload failed."))
    });
    const recorder = createRecorder();

    render(<App api={api} recorder={recorder} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await act(async () => {
      await expect(recorder.emitChunk(createChunk())).rejects.toThrow("Chunk upload failed.");
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Chunk upload failed.");
    expect(screen.getByRole("status")).toHaveTextContent("Needs attention");
  });

  it("finalizes an accepted session when recorder stop rejects after a chunk upload failure", async () => {
    const user = userEvent.setup();
    const api = createApi({
      uploadSessionChunk: vi.fn().mockRejectedValue(new Error("Chunk upload failed.")),
      finalizeSession: vi.fn().mockResolvedValue({
        sessionId: "session-1",
        transcriptPath: "C:\\recordings\\meeting-1\\transcript.txt",
        transcriptJsonPath: "C:\\recordings\\meeting-1\\transcript.json",
        partial: true
      })
    });
    const recorder = createRecorder({
      stop: vi.fn().mockRejectedValue(new Error("Chunk upload failed."))
    });

    render(<App api={api} recorder={recorder} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await act(async () => {
      await expect(recorder.emitChunk(createChunk())).rejects.toThrow("Chunk upload failed.");
    });

    await user.click(screen.getByRole("button", { name: "Stop and finalize" }));

    await waitFor(() => expect(api.finalizeSession).toHaveBeenCalledWith("session-1"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Chunk upload failed.");
    expect(screen.getByRole("status")).toHaveTextContent("Needs attention");
    expect(screen.getByText("Final transcript: C:\\recordings\\meeting-1\\transcript.txt")).toBeInTheDocument();
  });

  it("does not duplicate transcript text for replayed chunk transcription events", async () => {
    const user = userEvent.setup();
    const api = createApi();

    render(<App api={api} recorder={createRecorder()} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start recording" }));

    await act(async () => {
      emitEvent(api.lastEventHandlers, {
        type: "chunk-transcribed",
        sessionId: "session-1",
        chunkIndex: 1,
        text: "Transcript text",
        diarization: { available: true, enabled: true }
      });
      emitEvent(api.lastEventHandlers, {
        type: "chunk-transcribed",
        sessionId: "session-1",
        chunkIndex: 1,
        text: "Transcript text",
        diarization: { available: true, enabled: true }
      });
    });

    expect(await screen.findByText("Transcript text")).toBeInTheDocument();
    expect(screen.getAllByText("Transcript text")).toHaveLength(1);
    expect(screen.getByText("Chunks transcribed").closest(".metric")).toHaveTextContent("1");
  });

  it("ignores live events for a different session", async () => {
    const user = userEvent.setup();
    const api = createApi();

    render(<App api={api} recorder={createRecorder()} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start recording" }));

    await act(async () => {
      emitEvent(api.lastEventHandlers, {
        type: "chunk-transcribed",
        sessionId: "old-session",
        chunkIndex: 1,
        text: "Old transcript text",
        diarization: { available: true, enabled: true }
      });
    });

    await waitFor(() => expect(screen.queryByText("Old transcript text")).not.toBeInTheDocument());
    expect(screen.getByText("Chunks transcribed").closest(".metric")).toHaveTextContent("0");
  });

  it("disables controls while recording startup is in progress and prevents duplicate starts", async () => {
    const user = userEvent.setup();
    let resolveCreateSession: (value: Awaited<ReturnType<AppApi["createSession"]>>) => void;
    const createSession = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveCreateSession = resolve;
    }));
    const api = createApi({ createSession });

    render(<App api={api} recorder={createRecorder()} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start recording" }));

    const startButton = screen.getByRole("button", { name: "Start recording" });
    expect(startButton).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop and finalize" })).toBeDisabled();
    expect(screen.getByLabelText("Model")).toBeDisabled();
    await user.click(startButton);
    expect(createSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCreateSession({
        sessionId: "session-1",
        sessionPath: "C:\\recordings\\meeting-1",
        inProgressTranscriptPath: "C:\\recordings\\meeting-1\\transcript.in-progress.txt"
      });
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Stop and finalize" })).toBeEnabled());
  });

  it("ignores duplicate start clicks before the startup render completes", async () => {
    const pendingSessions: Array<(value: Awaited<ReturnType<AppApi["createSession"]>>) => void> = [];
    const createSession = vi.fn().mockImplementation(() => new Promise((resolve) => {
      pendingSessions.push(resolve);
    }));
    const api = createApi({ createSession });
    const recorder = createRecorder();

    render(<App api={api} recorder={recorder} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled());
    const startButton = screen.getByRole("button", { name: "Start recording" });

    act(() => {
      startButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      startButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(createSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingSessions[0]({
        sessionId: "session-1",
        sessionPath: "C:\\recordings\\meeting-1",
        inProgressTranscriptPath: "C:\\recordings\\meeting-1\\transcript.in-progress.txt"
      });
    });

    await waitFor(() => expect(recorder.startChunked).toHaveBeenCalledTimes(1));
  });

  it("shows attention status on live event stream errors while allowing active recording finalization", async () => {
    const user = userEvent.setup();
    const api = createApi();

    render(<App api={api} recorder={createRecorder()} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start recording" }));

    await act(async () => {
      api.lastEventHandlers?.onError(new Error("Stream disconnected."));
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Stream disconnected.");
    expect(screen.getByRole("status")).toHaveTextContent("Needs attention");
    expect(screen.getByRole("button", { name: "Stop and finalize" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Stop and finalize" }));
    await waitFor(() => expect(api.finalizeSession).toHaveBeenCalledWith("session-1"));
  });

  it("shows attention status for server-side chunk failures and still allows finalization", async () => {
    const user = userEvent.setup();
    const api = createApi();

    render(<App api={api} recorder={createRecorder()} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start recording" }));

    act(() => {
      emitEvent(api.lastEventHandlers, {
        type: "chunk-failed",
        sessionId: "session-1",
        chunkIndex: 2,
        message: "Decoder timed out."
      });
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Chunk 2 failed: Decoder timed out.");
    expect(screen.getByRole("status")).toHaveTextContent("Needs attention");
    expect(screen.getByText("Chunk failures").closest(".metric")).toHaveTextContent("1");

    await user.click(screen.getByRole("button", { name: "Stop and finalize" }));

    await waitFor(() => expect(api.finalizeSession).toHaveBeenCalledWith("session-1"));
  });

  it("does not recount replayed server-side chunk failure events", async () => {
    const user = userEvent.setup();
    const api = createApi();

    render(<App api={api} recorder={createRecorder()} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start recording" }));

    act(() => {
      emitEvent(api.lastEventHandlers, {
        type: "chunk-failed",
        sessionId: "session-1",
        chunkIndex: 2,
        message: "Decoder timed out."
      });
      emitEvent(api.lastEventHandlers, {
        type: "chunk-failed",
        sessionId: "session-1",
        chunkIndex: 2,
        message: "Decoder timed out."
      });
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Chunk 2 failed: Decoder timed out.");
    expect(screen.getByRole("status")).toHaveTextContent("Needs attention");
    expect(screen.getByText("Chunk failures").closest(".metric")).toHaveTextContent("1");
  });

  it("shows an error when live session finalization fails", async () => {
    const user = userEvent.setup();
    const api = createApi({
      finalizeSession: vi.fn().mockRejectedValue(new Error("Finalization failed."))
    });

    render(<App api={api} recorder={createRecorder()} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await user.click(screen.getByRole("button", { name: "Stop and finalize" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Finalization failed.");
    expect(screen.getByRole("status")).toHaveTextContent("Needs attention");
  });

  it("keeps attention status when live session finalizes with a partial transcript", async () => {
    const user = userEvent.setup();
    const api = createApi({
      finalizeSession: vi.fn().mockResolvedValue({
        sessionId: "session-1",
        transcriptPath: "C:\\recordings\\meeting-1\\transcript.txt",
        transcriptJsonPath: "C:\\recordings\\meeting-1\\transcript.json",
        partial: true
      })
    });

    render(<App api={api} recorder={createRecorder()} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await user.click(screen.getByRole("button", { name: "Stop and finalize" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Session finalized with a partial transcript.");
    expect(screen.getByRole("status")).toHaveTextContent("Needs attention");
    expect(screen.getByText("Final transcript: C:\\recordings\\meeting-1\\transcript.txt")).toBeInTheDocument();
  });

  it("transcribes uploaded audio with upload source type", async () => {
    const user = userEvent.setup();
    const api = createApi();
    const file = new File(["audio"], "meeting.wav", { type: "audio/wav" });

    render(<App api={api} recorder={createRecorder()} />);

    await waitFor(() => expect(screen.getByLabelText("Choose file")).toBeEnabled());
    await user.upload(screen.getByLabelText("Choose file"), file);

    await waitFor(() => {
      expect(api.transcribeAudio).toHaveBeenCalledWith(expect.objectContaining({
        audio: file,
        fileName: "meeting.wav",
        modelId: "small",
        sourceType: "upload"
      }));
    });
  });
});

type TestApi = AppApi & { lastEventHandlers?: SessionEventHandlers };

function createApi(overrides: Partial<AppApi> = {}): TestApi {
  const api = {
    getModels: vi.fn().mockResolvedValue({
      defaultModelId: "small",
      models: [
        { id: "tiny", label: "Tiny", recommended: false },
        { id: "small", label: "Small", recommended: true },
        { id: "large", label: "Large", recommended: false, warning: "Large is slower on CPU." }
      ]
    }),
    transcribeAudio: vi.fn().mockResolvedValue({
      sessionPath: "C:\\recordings\\meeting-1",
      transcript: { text: "Transcript text" }
    }),
    createSession: vi.fn().mockResolvedValue({
      sessionId: "session-1",
      sessionPath: "C:\\recordings\\meeting-1",
      inProgressTranscriptPath: "C:\\recordings\\meeting-1\\transcript.in-progress.txt"
    }),
    uploadSessionChunk: vi.fn().mockResolvedValue({ sessionId: "session-1", chunkIndex: 1, status: "queued" }),
    finalizeSession: vi.fn().mockResolvedValue({
      sessionId: "session-1",
      transcriptPath: "C:\\recordings\\meeting-1\\transcript.txt",
      transcriptJsonPath: "C:\\recordings\\meeting-1\\transcript.json",
      partial: false
    }),
    subscribeToSessionEvents: vi.fn((_sessionId, handlers) => {
      api.lastEventHandlers = handlers;
      return { close: vi.fn() };
    }),
    ...overrides
  } as TestApi;
  return api;
}

type TestRecorder = AppRecorder & { emitChunk(chunk: RecordedAudioChunk): Promise<void> };

function createRecorder(overrides: Partial<AppRecorder> = {}): TestRecorder {
  const recorder = {
    start: vi.fn().mockResolvedValue(undefined),
    startChunked: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(new Blob(["audio"], { type: "audio/webm" })),
    ...overrides
  } as TestRecorder;
  recorder.emitChunk = async (chunk: RecordedAudioChunk) => {
    const startChunked = recorder.startChunked as ReturnType<typeof vi.fn>;
    const options = startChunked.mock.calls.at(-1)?.[0];
    await options.onChunk(chunk);
  };
  return recorder;
}

function createChunk(overrides: Partial<RecordedAudioChunk> & { text?: string } = {}): RecordedAudioChunk {
  const text = overrides.text ?? "audio";
  return {
    chunkIndex: 1,
    startSeconds: 0,
    endSeconds: 30,
    overlapSeconds: 0,
    blob: new Blob([text], { type: "audio/webm" }),
    mimeType: "audio/webm",
    fileExtension: "webm",
    fileName: "chunk-000001.webm",
    ...overrides
  };
}

function emitEvent(handlers: SessionEventHandlers | undefined, event: SessionEvent) {
  if (!handlers) throw new Error("Missing session event handlers.");
  handlers.onEvent(event);
}
