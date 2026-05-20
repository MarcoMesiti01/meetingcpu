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

function parsedEvents(chunks: string[]): SessionEvent[] {
  return chunks.map((chunk) => JSON.parse(chunk.split("data: ")[1]) as SessionEvent);
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
        type: "chunk-saved",
        sessionId: "session-1",
        chunkIndex: 1
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

  it("removes failed writers and callbacks without interrupting delivery to remaining subscribers", () => {
    const hub = new SessionEventHub();
    const received: SessionEvent[] = [];
    let callbackAttempts = 0;
    let writerAttempts = 0;

    hub.subscribe("session-1", {
      write: () => {
        writerAttempts += 1;
        throw new Error("Client disconnected.");
      }
    });
    hub.subscribe("session-1", () => {
      callbackAttempts += 1;
      throw new Error("Client disconnected.");
    });
    hub.subscribe("session-1", (event) => {
      received.push(event);
    });

    const firstEvent: SessionEvent = { type: "chunk-saved", sessionId: "session-1", chunkIndex: 1 };
    const secondEvent: SessionEvent = { type: "chunk-saved", sessionId: "session-1", chunkIndex: 2 };

    expect(() => hub.publish(firstEvent)).not.toThrow();
    expect(() => hub.publish(secondEvent)).not.toThrow();

    expect(writerAttempts).toBe(1);
    expect(callbackAttempts).toBe(1);
    expect(received).toEqual([firstEvent, secondEvent]);
  });

  it("removes subscribers that fail while receiving replayed state", () => {
    const hub = new SessionEventHub();
    let attempts = 0;

    hub.publish({ type: "chunk-saved", sessionId: "session-1", chunkIndex: 1 });

    expect(() =>
      hub.subscribe("session-1", () => {
        attempts += 1;
        throw new Error("Replay failed.");
      })
    ).toThrow("Replay failed.");

    expect(() => hub.publish({ type: "chunk-saved", sessionId: "session-1", chunkIndex: 2 })).not.toThrow();
    expect(attempts).toBe(1);
  });

  it("clears replay state for finalized sessions after active subscribers receive the final event", () => {
    const hub = new SessionEventHub();
    const active = writer();
    const late = writer();
    hub.subscribe("session-1", active);

    hub.publish({
      type: "session-created",
      sessionId: "session-1",
      sessionPath: "/data/session-1",
      inProgressTranscriptPath: "/data/session-1/transcript.in-progress.txt"
    });
    hub.publish({ type: "chunk-saved", sessionId: "session-1", chunkIndex: 1 });
    hub.publish({
      type: "session-finalized",
      sessionId: "session-1",
      transcriptPath: "/data/session-1/transcript.txt",
      partial: false
    });

    hub.subscribe("session-1", late);

    expect(active.chunks.map((chunk) => chunk.match(/^event: (.+)$/m)?.[1])).toEqual([
      "session-created",
      "chunk-saved",
      "session-finalized"
    ]);
    expect(late.chunks).toEqual([]);
  });

  it("replays chunks in deterministic transcript order after out-of-order completion", () => {
    const hub = new SessionEventHub();
    const subscribed = writer();

    hub.publish({
      type: "session-created",
      sessionId: "session-1",
      sessionPath: "/data/session-1",
      inProgressTranscriptPath: "/data/session-1/transcript.in-progress.txt"
    });
    hub.publish({ type: "chunk-saved", sessionId: "session-1", chunkIndex: 2 });
    hub.publish({
      type: "chunk-transcribed",
      sessionId: "session-1",
      chunkIndex: 2,
      text: "Second",
      diarization: { available: true, enabled: false }
    });
    hub.publish({ type: "chunk-saved", sessionId: "session-1", chunkIndex: 1 });
    hub.publish({
      type: "chunk-transcribed",
      sessionId: "session-1",
      chunkIndex: 1,
      text: "First",
      diarization: { available: true, enabled: false }
    });

    hub.subscribe("session-1", subscribed);

    expect(parsedEvents(subscribed.chunks)).toEqual([
      {
        type: "session-created",
        sessionId: "session-1",
        sessionPath: "/data/session-1",
        inProgressTranscriptPath: "/data/session-1/transcript.in-progress.txt"
      },
      { type: "chunk-saved", sessionId: "session-1", chunkIndex: 1 },
      {
        type: "chunk-transcribed",
        sessionId: "session-1",
        chunkIndex: 1,
        text: "First",
        diarization: { available: true, enabled: false }
      },
      { type: "chunk-saved", sessionId: "session-1", chunkIndex: 2 },
      {
        type: "chunk-transcribed",
        sessionId: "session-1",
        chunkIndex: 2,
        text: "Second",
        diarization: { available: true, enabled: false }
      }
    ]);
  });
});
