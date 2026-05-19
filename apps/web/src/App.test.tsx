import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import App, { type AppApi, type AppRecorder } from "./App";

describe("App", () => {
  it("loads model choices and starts ready", async () => {
    const api = createApi();
    const recorder = createRecorder();

    render(<App api={api} recorder={recorder} />);

    expect(screen.getByRole("heading", { name: "Local Meeting Transcription" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Model")).toHaveValue("small"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled());
  });

  it("records microphone audio, transcribes it, and shows transcript with saved path", async () => {
    const user = userEvent.setup();
    const api = createApi({
      transcribeAudio: vi.fn().mockResolvedValue({
        sessionPath: "C:\\recordings\\meeting-1",
        transcript: { text: "We agreed to ship the local UI." }
      })
    });
    const recorder = createRecorder();

    render(<App api={api} recorder={recorder} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await user.click(screen.getByRole("button", { name: "Stop and transcribe" }));

    await waitFor(() => {
      expect(api.transcribeAudio).toHaveBeenCalledWith(expect.objectContaining({
        audio: expect.any(Blob),
        fileName: expect.stringMatching(/^recording-.*\.webm$/),
        modelId: "small",
        sourceType: "microphone"
      }));
    });
    expect(recorder.start).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("We agreed to ship the local UI.")).toBeInTheDocument();
    expect(screen.getByText("Saved in: C:\\recordings\\meeting-1")).toBeInTheDocument();
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
      start: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("Microphone permission denied."))
    });

    render(<App api={api} recorder={recorder} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await user.click(screen.getByRole("button", { name: "Stop and transcribe" }));
    expect(await screen.findByText("Transcript text")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Start recording" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Microphone permission denied."));
    expect(screen.getByText("Transcript text")).toBeInTheDocument();
  });

  it("shows an error when transcription fails", async () => {
    const user = userEvent.setup();
    const api = createApi({
      transcribeAudio: vi.fn().mockRejectedValue(new Error("Transcription service failed."))
    });
    const recorder = createRecorder();

    render(<App api={api} recorder={recorder} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Start recording" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Start recording" }));
    await user.click(screen.getByRole("button", { name: "Stop and transcribe" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Transcription service failed.");
    expect(screen.getByRole("status")).toHaveTextContent("Needs attention");
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

function createApi(overrides: Partial<AppApi> = {}): AppApi {
  return {
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
    ...overrides
  };
}

function createRecorder(overrides: Partial<AppRecorder> = {}): AppRecorder {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(new Blob(["audio"], { type: "audio/webm" })),
    ...overrides
  };
}
