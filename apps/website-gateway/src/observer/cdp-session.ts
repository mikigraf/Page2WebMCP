const MAX_MESSAGE_BYTES = 512 * 1_024;
const CALL_TIMEOUT_MS = 15_000;

type Pending = Readonly<{ resolve(value: Record<string, unknown>): void; reject(error: Error): void }>;

export type CdpEventHandler = (parameters: Record<string, unknown>, sessionId: string | undefined) => void;

export type CdpSession = Readonly<{
  send(method: string, parameters?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>>;
  on(method: string, handler: CdpEventHandler): void;
  close(): void;
}>;

export class CdpError extends Error {
  constructor(code: string) { super(code); this.name = "CdpError"; }
}

/**
 * A minimal Chrome DevTools Protocol client over the session's CDP websocket.
 * It never records page content or URLs: callers decide what, if anything, to
 * keep from the events they subscribe to.
 */
export async function connectCdpSession(url: string, signal: AbortSignal): Promise<CdpSession> {
  if (!url.startsWith("wss://")) throw new CdpError("CDP_ENDPOINT_INVALID");
  const socket = new WebSocket(url);
  const pending = new Map<number, Pending>();
  const handlers = new Map<string, CdpEventHandler[]>();
  let nextId = 1;
  let closed = false;

  const fail = (code: string) => {
    closed = true;
    for (const [id, entry] of pending) { pending.delete(id); entry.reject(new CdpError(code)); }
  };

  socket.addEventListener("message", (event) => {
    const raw = typeof event.data === "string" ? event.data : "";
    if (raw.length > MAX_MESSAGE_BYTES) return;
    let message: Record<string, unknown>;
    try { message = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
    if (typeof message.id === "number") {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new CdpError("CDP_COMMAND_FAILED"));
      else entry.resolve((message.result ?? {}) as Record<string, unknown>);
      return;
    }
    if (typeof message.method === "string") {
      for (const handler of handlers.get(message.method) ?? []) {
        handler((message.params ?? {}) as Record<string, unknown>,
          typeof message.sessionId === "string" ? message.sessionId : undefined);
      }
    }
  });
  socket.addEventListener("close", () => fail("CDP_CONNECTION_CLOSED"));
  socket.addEventListener("error", () => fail("CDP_CONNECTION_FAILED"));

  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(new CdpError("CDP_CONNECTION_ABORTED"));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new CdpError("CDP_CONNECTION_FAILED")), { once: true });
  });

  const session: CdpSession = {
    send(method, parameters = {}, sessionId) {
      if (closed || socket.readyState !== WebSocket.OPEN) return Promise.reject(new CdpError("CDP_CONNECTION_CLOSED"));
      const id = nextId++;
      const payload = JSON.stringify({ id, method, params: parameters, ...(sessionId ? { sessionId } : {}) });
      if (payload.length > MAX_MESSAGE_BYTES) return Promise.reject(new CdpError("CDP_COMMAND_TOO_LARGE"));
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new CdpError("CDP_COMMAND_TIMEOUT"));
        }, CALL_TIMEOUT_MS);
        timer.unref?.();
        pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
        socket.send(payload);
      });
    },
    on(method, handler) {
      handlers.set(method, [...(handlers.get(method) ?? []), handler]);
    },
    close() {
      closed = true;
      try { socket.close(); } catch { /* the socket is already gone */ }
    },
  };
  return session;
}
