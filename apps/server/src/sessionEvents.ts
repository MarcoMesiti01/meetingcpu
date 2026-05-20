export type SessionEvent =
  | { type: "session-created"; sessionId: string; sessionPath: string; inProgressTranscriptPath: string }
  | { type: "chunk-saved"; sessionId: string; chunkIndex: number }
  | {
      type: "chunk-transcribed";
      sessionId: string;
      chunkIndex: number;
      text: string;
      diarization: { available: boolean; enabled: boolean; error?: string };
    }
  | { type: "chunk-failed"; sessionId: string; chunkIndex: number; code: string; message: string }
  | { type: "session-finalized"; sessionId: string; transcriptPath: string; partial: boolean };

export interface SessionEventWriter {
  write(chunk: string): unknown;
}

export type SessionEventCallback = (event: SessionEvent) => void;
export type SessionEventSubscriber = SessionEventWriter | SessionEventCallback;

interface StoredSessionEvent {
  sequence: number;
  event: SessionEvent;
}

export class SessionEventHub {
  private readonly subscribers = new Map<string, Map<symbol, SessionEventSubscriber>>();
  private readonly sessionState = new Map<string, Map<string, StoredSessionEvent>>();
  private nextSequence = 0;

  publish(event: SessionEvent): void {
    this.storeLatestState(event);

    const sessionSubscribers = this.subscribers.get(event.sessionId);
    if (!sessionSubscribers) {
      return;
    }

    for (const subscriber of sessionSubscribers.values()) {
      notifySubscriber(subscriber, event);
    }
  }

  subscribe(sessionId: string, subscriber: SessionEventSubscriber): () => void {
    const token = Symbol(sessionId);
    const sessionSubscribers = this.subscribers.get(sessionId) ?? new Map<symbol, SessionEventSubscriber>();
    sessionSubscribers.set(token, subscriber);
    this.subscribers.set(sessionId, sessionSubscribers);

    for (const storedEvent of this.latestState(sessionId)) {
      notifySubscriber(subscriber, storedEvent);
    }

    return () => {
      const currentSubscribers = this.subscribers.get(sessionId);
      if (!currentSubscribers) {
        return;
      }
      currentSubscribers.delete(token);
      if (currentSubscribers.size === 0) {
        this.subscribers.delete(sessionId);
      }
    };
  }

  private storeLatestState(event: SessionEvent): void {
    const state = this.sessionState.get(event.sessionId) ?? new Map<string, StoredSessionEvent>();
    state.set(stateKey(event), { sequence: this.nextSequence, event });
    this.nextSequence += 1;
    this.sessionState.set(event.sessionId, state);
  }

  private latestState(sessionId: string): SessionEvent[] {
    return [...(this.sessionState.get(sessionId)?.values() ?? [])]
      .sort((left, right) => left.sequence - right.sequence)
      .map((storedEvent) => storedEvent.event);
  }
}

export function formatSseEvent(event: SessionEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function notifySubscriber(subscriber: SessionEventSubscriber, event: SessionEvent): void {
  if (typeof subscriber === "function") {
    subscriber(event);
    return;
  }

  subscriber.write(formatSseEvent(event));
}

function stateKey(event: SessionEvent): string {
  switch (event.type) {
    case "session-created":
    case "session-finalized":
      return event.type;
    case "chunk-saved":
    case "chunk-transcribed":
    case "chunk-failed":
      return `chunk:${event.chunkIndex}`;
  }
}
