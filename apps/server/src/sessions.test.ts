import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createSession, saveRecording, saveTranscript, sessionSlugFromDate } from "./sessions.js";

describe("session storage", () => {
  it("creates a safe dated session folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const session = await createSession({
      dataRoot: root,
      now: new Date("2026-05-18T13:30:00.000Z"),
      title: "Design Sync / CPU?"
    });

    expect(session.id).toBe("2026-05-18-1330-design-sync-cpu");
    expect(session.path).toBe(join(root, "sessions", "2026-05-18-1330-design-sync-cpu"));
    expect((await stat(session.path)).isDirectory()).toBe(true);
  });

  it("creates a unique folder when session slugs collide", async () => {
    const root = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const first = await createSession({
      dataRoot: root,
      now: new Date("2026-05-18T13:30:00.000Z"),
      title: "Local Meeting"
    });
    const second = await createSession({
      dataRoot: root,
      now: new Date("2026-05-18T13:30:00.000Z"),
      title: "Local Meeting"
    });

    expect(first.id).toBe("2026-05-18-1330-local-meeting");
    expect(second.id).toBe("2026-05-18-1330-local-meeting-2");
    expect((await stat(first.path)).isDirectory()).toBe(true);
    expect((await stat(second.path)).isDirectory()).toBe(true);
  });

  it("saves the original recording and metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const session = await createSession({
      dataRoot: root,
      now: new Date("2026-05-18T13:30:00.000Z"),
      title: "Local Meeting"
    });

    const saved = await saveRecording({
      session,
      originalName: "meeting.webm",
      buffer: Buffer.from("audio-bytes"),
      sourceType: "microphone",
      modelId: "small"
    });

    expect(saved.recordingPath.endsWith("recording.webm")).toBe(true);
    await expect(readFile(saved.recordingPath, "utf8")).resolves.toBe("audio-bytes");
    const metadata = JSON.parse(await readFile(join(session.path, "metadata.json"), "utf8"));
    expect(metadata).toMatchObject({
      sourceType: "microphone",
      modelId: "small",
      status: "recording-saved"
    });
  });

  it("writes transcript json and text files", async () => {
    const root = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const session = await createSession({
      dataRoot: root,
      now: new Date("2026-05-18T13:30:00.000Z"),
      title: "Transcript"
    });

    await saveTranscript({
      session,
      transcript: {
        text: "  Hello world.  ",
        language: "en",
        durationSeconds: 3.2,
        segments: [{ start: 0, end: 3.2, text: "Hello world." }]
      },
      modelId: "small"
    });

    await expect(readFile(join(session.path, "transcript.txt"), "utf8")).resolves.toBe("  Hello world.  \n");
    const json = JSON.parse(await readFile(join(session.path, "transcript.json"), "utf8"));
    expect(json.segments[0]).toEqual({ start: 0, end: 3.2, text: "Hello world." });
  });

  it("preserves recording metadata when saving transcript metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "meetingcpu-"));
    const session = await createSession({
      dataRoot: root,
      now: new Date("2026-05-18T13:30:00.000Z"),
      title: "Metadata"
    });
    const saved = await saveRecording({
      session,
      originalName: "meeting.webm",
      buffer: Buffer.from("audio-bytes"),
      sourceType: "microphone",
      modelId: "small"
    });

    await saveTranscript({
      session,
      transcript: {
        text: "Hello world.",
        language: "en",
        durationSeconds: 3.2,
        segments: [{ start: 0, end: 3.2, text: "Hello world." }]
      },
      modelId: "small"
    });

    const metadata = JSON.parse(await readFile(join(session.path, "metadata.json"), "utf8"));
    expect(metadata).toMatchObject({
      sessionId: session.id,
      sourceType: "microphone",
      recordingPath: saved.recordingPath,
      status: "transcribed",
      language: "en",
      durationSeconds: 3.2,
      modelId: "small"
    });
  });

  it("normalizes empty titles to local meeting", () => {
    expect(sessionSlugFromDate(new Date("2026-05-18T13:30:00.000Z"), "")).toBe(
      "2026-05-18-1330-local-meeting"
    );
  });
});
