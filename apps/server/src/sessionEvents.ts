export type SessionEvent =
  | { type: "session-created"; sessionId: string; sessionPath: string; inProgressTranscriptPath: string }
  | { type: "chunk-saved"; sessionId: string; chunkIndex: number }
  | {
      type: "chunk-transcribed";
      sessionId: string;
      chunkIndex: number;
      text: string;
      acceptedText?: string;
      acceptedSegments?: Array<{ start: number; end: number; text: string; speaker?: string }>;
      transcriptText?: string;
      transcriptSegments?: Array<{ start: number; end: number; text: string; speaker?: string }>;
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
    if (sessionSubscribers) {
      for (const [token, subscriber] of sessionSubscribers.entries()) {
        this.notifyAndRemoveOnFailure(event.sessionId, token, subscriber, event);
      }
    }

    if (event.type === "session-finalized") {
      this.clearSession(event.sessionId);
    }
  }

  subscribe(sessionId: string, subscriber: SessionEventSubscriber): () => void {
    const token = Symbol(sessionId);
    const sessionSubscribers = this.subscribers.get(sessionId) ?? new Map<symbol, SessionEventSubscriber>();
    sessionSubscribers.set(token, subscriber);
    this.subscribers.set(sessionId, sessionSubscribers);

    for (const storedEvent of this.latestState(sessionId)) {
      this.notifyReplaySubscriber(sessionId, token, subscriber, storedEvent);
    }

    return () => {
      this.removeSubscriber(sessionId, token);
    };
  }

  clearSession(sessionId: string): void {
    this.sessionState.delete(sessionId);
  }

  private notifyAndRemoveOnFailure(
    sessionId: string,
    token: symbol,
    subscriber: SessionEventSubscriber,
    event: SessionEvent
  ): void {
    try {
      const result = notifySubscriber(subscriber, event);
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => {
          this.removeSubscriber(sessionId, token);
        });
      }
    } catch {
      this.removeSubscriber(sessionId, token);
    }
  }

  private notifyReplaySubscriber(
    sessionId: string,
    token: symbol,
    subscriber: SessionEventSubscriber,
    event: SessionEvent
  ): void {
    try {
      const result = notifySubscriber(subscriber, event);
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => {
          this.removeSubscriber(sessionId, token);
        });
      }
    } catch (error) {
      this.removeSubscriber(sessionId, token);
      throw error;
    }
  }

  private removeSubscriber(sessionId: string, token: symbol): void {
    const currentSubscribers = this.subscribers.get(sessionId);
    if (!currentSubscribers) {
      return;
    }
    currentSubscribers.delete(token);
    if (currentSubscribers.size === 0) {
      this.subscribers.delete(sessionId);
    }
  }

  private storeLatestState(event: SessionEvent): void {
    const state = this.sessionState.get(event.sessionId) ?? new Map<string, StoredSessionEvent>();
    state.set(stateKey(event), { sequence: this.nextSequence, event });
    this.nextSequence += 1;
    this.sessionState.set(event.sessionId, state);
  }

  private latestState(sessionId: string): SessionEvent[] {
    return [...(this.sessionState.get(sessionId)?.values() ?? [])]
      .sort(compareStoredSessionEvents)
      .map((storedEvent) => storedEvent.event);
  }
}

export function formatSseEvent(event: SessionEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function notifySubscriber(subscriber: SessionEventSubscriber, event: SessionEvent): unknown {
  if (typeof subscriber === "function") {
    return subscriber(event);
  }

  return subscriber.write(formatSseEvent(event));
}

function stateKey(event: SessionEvent): string {
  switch (event.type) {
    case "session-created":
    case "session-finalized":
      return event.type;
    case "chunk-saved":
      return `chunk:${event.chunkIndex}:saved`;
    case "chunk-transcribed":
    case "chunk-failed":
      return `chunk:${event.chunkIndex}:result`;
  }
}

function compareStoredSessionEvents(left: StoredSessionEvent, right: StoredSessionEvent): number {
  return eventGroup(left.event) - eventGroup(right.event) || left.sequence - right.sequence;
}

function eventGroup(event: SessionEvent): number {
  switch (event.type) {
    case "session-created":
      return 0;
    case "chunk-saved":
    case "chunk-transcribed":
    case "chunk-failed":
      return 1;
    case "session-finalized":
      return 2;
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}
