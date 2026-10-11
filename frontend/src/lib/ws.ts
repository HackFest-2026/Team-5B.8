/**
 * The live WebSocket connection.
 *
 * Design notes that matter:
 *
 *  - ONE socket per project, shared by every component. Five panels on the live
 *    dashboard subscribing independently would open five sockets and count as
 *    five viewers in `/live/connections`, which is both wasteful and wrong.
 *    Components subscribe to this object; it owns the single socket.
 *
 *  - The socket carries NO BACKLOG. Anything published while we were
 *    disconnected is gone. So reconnecting is not enough — the UI has to
 *    resynchronise from `/live/pulse`. This module does not call pulse itself
 *    (that would couple it to the API layer); it emits a `resync` event and the
 *    dashboard hook does the refetch. That keeps the reconnect rule in one
 *    obvious place instead of scattered through components.
 *
 *  - Authentication happens at $connect and nowhere else. There is no 401 frame
 *    after a socket opens, so a rejected token shows up as an immediate close.
 *    We treat a close during the opening handshake as fatal rather than
 *    retrying forever against a token the server has already refused.
 */

export const CHANNELS = ['events', 'decisions', 'kpis', 'alerts', 'health'] as const;
export type Channel = (typeof CHANNELS)[number];

/** What the status indicator shows. Deliberately human, not technical. */
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline';

/* ── frame payloads, matching core/realtime.py exactly ─────────────────── */

export interface LiveEvent {
  ts: number;
  item_id: string;
  event_type: string;
  quantity: number | null;
  value: number | null;
}

export interface EventsPayload {
  events: LiveEvent[];
  count: number;
}

export interface DecisionPayload {
  decision_id: string;
  item_id: string;
  previous_price: number | null;
  price: number;
  changed: boolean;
  change_pct: number;
  rules_fired: string[];
  guardrails_applied: string[];
  strategy_version: string | null;
  degraded: boolean;
  fallback: boolean;
  latency_ms: number | null;
}

export interface SignalsPayload {
  type: 'signals';
  item_id: string;
  signals: Record<string, number | string | boolean>;
}

export interface AlertPayload {
  alert_id: string;
  severity: 'info' | 'warning' | 'critical';
  type: string | null;
  title: string;
  message: string | null;
  item_id: string | null;
  approval_id: string | null;
  needs_decision: boolean;
}

export type HealthPayload = Record<string, unknown>;

/** A frame as it arrives on the wire. */
export interface Frame<T = unknown> {
  channel: Channel;
  ts: number;
  project_id: string;
  data: T;
  /** Set when the payload was too large to send; refetch over REST instead. */
  truncated?: boolean;
}

/** Narrowed frame types, so a handler does not have to cast. */
export type ChannelPayload = {
  events: EventsPayload;
  decisions: DecisionPayload;
  kpis: SignalsPayload;
  alerts: AlertPayload;
  health: HealthPayload;
};

type FrameHandler<C extends Channel> = (data: ChannelPayload[C], frame: Frame) => void;
type StateHandler = (state: ConnectionState) => void;
type ResyncHandler = () => void;

const WS_BASE = (import.meta.env.VITE_WS_BASE ?? '').replace(/\/$/, '');

/**
 * Reconnect backoff.
 *
 * Capped at 15s and jittered. Without jitter, every browser tab that lost
 * connection to the same deployment would come back in lockstep and arrive as
 * one thundering herd — on a Lambda-backed API with a low concurrency ceiling
 * that turns a blip into an outage.
 */
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000];

function backoff(attempt: number): number {
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 15000;
  return base + Math.random() * base * 0.3;
}

/**
 * Keepalive interval.
 *
 * API Gateway closes a WebSocket after 10 minutes with no traffic in EITHER
 * direction, so an idle dashboard would be disconnected while the user is still
 * looking at it. A client→server frame resets that timer, so this ping keeps the
 * socket alive on its own.
 *
 * It is deliberately fire-and-forget: NO reply is expected, and none arrives.
 * The deployed WebSocket API has no `RouteResponse` configured, which means API
 * Gateway discards whatever the Lambda returns — the handler does answer a ping
 * with `{"pong": ...}`, but that body never reaches the browser. This was
 * verified against the live socket: it opens, accepts pings, and sends nothing
 * back.
 *
 * So there is no application-level liveness check available here, and a timeout
 * waiting for a pong would close every HEALTHY socket on a timer. Staleness is
 * caught instead by the slow `/live/pulse` poll the dashboard already runs,
 * which re-reads authoritative state regardless of what the socket is doing.
 */
const PING_INTERVAL_MS = 240_000; // 4 min, comfortably inside the 10-minute idle window

export class LiveConnection {
  private socket: WebSocket | null = null;
  private state: ConnectionState = 'offline';
  private attempt = 0;
  private closedByUs = false;
  private reconnectTimer: number | null = null;
  private pingTimer: number | null = null;
  /** True once a socket has opened at least once, so the next open is a RE-open
   *  and therefore needs a resync. The very first open does not. */
  private hasConnectedBefore = false;

  private readonly handlers = new Map<Channel, Set<FrameHandler<Channel>>>();
  private readonly stateHandlers = new Set<StateHandler>();
  private readonly resyncHandlers = new Set<ResyncHandler>();

  constructor(
    private readonly projectId: string,
    private readonly token: string,
    private readonly channels: readonly Channel[] = CHANNELS,
  ) {}

  getState(): ConnectionState {
    return this.state;
  }

  /* ── subscription ───────────────────────────────────────────────────── */

  on<C extends Channel>(channel: C, fn: FrameHandler<C>): () => void {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(fn as FrameHandler<Channel>);
    return () => set?.delete(fn as FrameHandler<Channel>);
  }

  onStateChange(fn: StateHandler): () => void {
    this.stateHandlers.add(fn);
    return () => this.stateHandlers.delete(fn);
  }

  /** Fired after a RE-connect, meaning "your view may have gaps — refetch". */
  onResync(fn: ResyncHandler): () => void {
    this.resyncHandlers.add(fn);
    return () => this.resyncHandlers.delete(fn);
  }

  /* ── lifecycle ──────────────────────────────────────────────────────── */

  connect(): void {
    if (!WS_BASE) {
      // Without a configured endpoint there is nothing to retry towards, so
      // say offline once rather than looping.
      this.setState('offline');
      return;
    }
    if (this.socket && (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.closedByUs = false;
    this.setState(this.hasConnectedBefore ? 'reconnecting' : 'connecting');

    const qs = new URLSearchParams({
      token: this.token,
      project_id: this.projectId,
      channels: this.channels.join(','),
    });

    let socket: WebSocket;
    try {
      socket = new WebSocket(`${WS_BASE}?${qs.toString()}`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      const reopened = this.hasConnectedBefore;
      this.hasConnectedBefore = true;
      this.setState('connected');
      this.startPing();
      // Only a re-open implies missed frames. Emitting this on the first
      // connection would make every dashboard load fetch pulse twice.
      if (reopened) for (const fn of this.resyncHandlers) fn();
    };

    socket.onmessage = (ev) => {
      let frame: Frame;
      try {
        frame = JSON.parse(ev.data as string) as Frame;
      } catch {
        return; // a malformed frame is not worth tearing the socket down for
      }
      // Pings and acks come back without a channel; nothing to dispatch.
      if (!frame.channel) return;
      // A frame for another project means a stale socket from a project switch
      // that has not finished closing. Dropping it prevents the cardinal sin of
      // mixing two projects' data on one screen.
      if (frame.project_id && frame.project_id !== this.projectId) return;

      if (frame.truncated) {
        // The payload was too big to send. Treat it exactly like a reconnect:
        // the only correct recovery is to refetch over REST.
        for (const fn of this.resyncHandlers) fn();
        return;
      }

      const set = this.handlers.get(frame.channel);
      if (!set) return;
      for (const fn of set) {
        try {
          fn(frame.data as ChannelPayload[Channel], frame);
        } catch (err) {
          // One bad handler must not stop the others from seeing the frame.
          console.error('live handler failed', err);
        }
      }
    };

    socket.onerror = () => {
      /* `onclose` always follows, and handles the retry. */
    };

    socket.onclose = (ev) => {
      this.stopPing();
      if (this.closedByUs) {
        this.setState('offline');
        return;
      }
      // A close before we ever opened, with a policy code, means the handshake
      // was refused — a dead token or a project this tenant does not own.
      // Retrying cannot fix either, so stop and let the app re-authenticate.
      if (!this.hasConnectedBefore && (ev.code === 1008 || ev.code === 1002)) {
        this.setState('offline');
        return;
      }
      this.scheduleReconnect();
    };
  }

  close(): void {
    this.closedByUs = true;
    this.clearTimer();
    this.stopPing();
    this.socket?.close();
    this.socket = null;
    this.setState('offline');
  }

  /* ── keepalive ──────────────────────────────────────────────────────── */

  private startPing(): void {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      try {
        this.socket.send(JSON.stringify({ action: 'ping' }));
      } catch {
        // A failed send means the socket is already gone; `onclose` will fire
        // and run the normal reconnect path.
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /* ── reconnection ───────────────────────────────────────────────────── */

  private scheduleReconnect(): void {
    this.clearTimer();
    this.setState('reconnecting');
    const delay = backoff(this.attempt++);
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  private clearTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    for (const fn of this.stateHandlers) fn(next);
  }
}

/** The wording the status indicator shows. Technical codes never reach the UI. */
export function describeState(state: ConnectionState): string {
  switch (state) {
    case 'connected':
      return 'Live';
    case 'connecting':
      return 'Connecting';
    case 'reconnecting':
      return 'Reconnecting';
    case 'offline':
      return 'Offline';
  }
}
