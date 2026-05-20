import { describe, expect, it } from "vitest";
import { SessionEventHub, formatSseEvent, type SessionEvent } from "./sessionEvents.js";

function writer(): { chunks: string[]; write: (chunk: string) => void } {
  const chunks: string[] = [];
  return {
    chunks,
    write(chunk: string) {
      chunks.push(chunk);
    }
  };
}

describe("session events", () => {
  it("formats events as JSON server-sent events", () => {
    const event: SessionEvent = {
      type: "chunk-transcribed",
      sessionId: "session-1",
      chunkIndex: 2,
      text: "Hello",
      diarization: { available: true, enabled: false, error: "No speakers detected." }
    };

    expect(formatSseEvent(event)).toBe(
      'event: chunk-transcribed\ndata: {"type":"chunk-transcribed","sessionId":"session-1","chunkIndex":2,"text":"Hello","diarization":{"available":true,"enabled":false,"error":"No speakers detected."}}\n\n'
    );
  });

  it("subscribes, publishes matching session events, and unsubscribes cleanly", () => {
    const hub = new SessionEventHub();
    const subscribed = writer();
    const otherSession = writer();

    const unsubscribe = hub.subscribe("session-1", subscribed);
    hub.subscribe("session-2", otherSession);

    hub.publish({
      type: "chunk-saved",
      sessionId: "session-1",
      chunkIndex: 1
    });
    hub.publish({
      type: "chunk-saved",
      sessionId: "session-2",
      chunkIndex: 1
    });

    unsubscribe();
    hub.publish({
      type: "chunk-saved",
      sessionId: "session-1",
      chunkIndex: 2
    });

    expect(subscribed.chunks).toEqual([
      'event: chunk-saved\ndata: {"type":"chunk-saved","sessionId":"session-1","chunkIndex":1}\n\n'
    ]);
    expect(otherSession.chunks).toEqual([
      'event: chunk-saved\ndata: {"type":"chunk-saved","sessionId":"session-2","chunkIndex":1}\n\n'
    ]);
  });

  it("replays the latest session state when a subscriber connects", () => {
    const hub = new SessionEventHub();
    const subscribed = writer();

    hub.publish({
      type: "session-created",
      sessionId: "session-1",
      sessionPath: "/data/session-1",
      inProgressTranscriptPath: "/data/session-1/transcript.in-progress.txt"
    });
    hub.publish({ type: "chunk-saved", sessionId: "session-1", chunkIndex: 1 });
    hub.publish({
      type: "chunk-transcribed",
      sessionId: "session-1",
      chunkIndex: 1,
      text: "Draft text",
      diarization: { available: false, enabled: false }
    });
    hub.publish({ type: "chunk-saved", sessionId: "session-1", chunkIndex: 2 });

    hub.subscribe("session-1", subscribed);

    expect(subscribed.chunks.map((chunk) => JSON.parse(chunk.split("data: ")[1]))).toEqual([
      {
        type: "session-created",
        sessionId: "session-1",
        sessionPath: "/data/session-1",
        inProgressTranscriptPath: "/data/session-1/transcript.in-progress.txt"
      },
      {
        type: "chunk-transcribed",
        sessionId: "session-1",
        chunkIndex: 1,
        text: "Draft text",
        diarization: { available: false, enabled: false }
      },
      { type: "chunk-saved", sessionId: "session-1", chunkIndex: 2 }
    ]);
  });

  it("preserves publish order for active subscribers", () => {
    const hub = new SessionEventHub();
    const subscribed = writer();
    hub.subscribe("session-1", subscribed);

    hub.publish({ type: "chunk-saved", sessionId: "session-1", chunkIndex: 1 });
    hub.publish({
      type: "chunk-transcribed",
      sessionId: "session-1",
      chunkIndex: 1,
      text: "First",
      diarization: { available: true, enabled: true }
    });
    hub.publish({
      type: "chunk-failed",
      sessionId: "session-1",
      chunkIndex: 2,
      code: "TRANSCRIBE_FAILED",
      message: "Unable to transcribe chunk."
    });

    expect(subscribed.chunks.map((chunk) => chunk.match(/^event: (.+)$/m)?.[1])).toEqual([
      "chunk-saved",
      "chunk-transcribed",
      "chunk-failed"
    ]);
  });
});
