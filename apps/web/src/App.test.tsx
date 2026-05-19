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

function createRecorder(): AppRecorder {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(new Blob(["audio"], { type: "audio/webm" }))
  };
}
