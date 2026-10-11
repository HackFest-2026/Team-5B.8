import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getToken } from '@/api/client';
import { useSession } from './useSession';
import {
  LiveConnection,
  type Channel,
  type ChannelPayload,
  type ConnectionState,
} from '@/lib/ws';

/**
 * Owns the one WebSocket for the currently selected project.
 *
 * Mounted inside the app shell, so the socket's lifetime matches the time the
 * user is inside the application, and switching project tears the old socket
 * down and opens a new one. That teardown is the important part: a lingering
 * socket for the previous project would keep pushing its frames, and the one
 * rule the spec states twice is that project data must never mix.
 */

interface LiveContextValue {
  state: ConnectionState;
  /** Subscribe to a channel. Returns an unsubscribe function. */
  subscribe: <C extends Channel>(
    channel: C,
    fn: (data: ChannelPayload[C]) => void,
  ) => () => void;
  /**
   * Register a resync callback, invoked after a reconnect or a dropped oversized
   * frame. The dashboard answers it by refetching `/live/pulse`.
   */
  onResync: (fn: () => void) => () => void;
}

const LiveContext = createContext<LiveContextValue | null>(null);

export function LiveProvider({ children }: { children: ReactNode }) {
  const { projectId } = useSession();
  const [state, setState] = useState<ConnectionState>('offline');
  const connRef = useRef<LiveConnection | null>(null);

  // Callbacks registered by components. They are held here rather than passed
  // to the connection directly so that a subscription survives a reconnect —
  // the LiveConnection instance is replaced on a project switch, and components
  // must not have to resubscribe.
  const handlers = useRef(new Map<Channel, Set<(data: never) => void>>());
  const resyncHandlers = useRef(new Set<() => void>());

  useEffect(() => {
    const token = getToken();
    if (!projectId || !token) {
      setState('offline');
      return;
    }

    const conn = new LiveConnection(projectId, token);
    connRef.current = conn;

    const offState = conn.onStateChange(setState);
    const offResync = conn.onResync(() => {
      for (const fn of resyncHandlers.current) fn();
    });

    // Bridge every channel once, and fan out to whoever is listening. One
    // socket handler per channel regardless of how many components subscribe.
    const offChannels = (['events', 'decisions', 'kpis', 'alerts', 'health'] as const).map(
      (channel) =>
        conn.on(channel, (data) => {
          const set = handlers.current.get(channel);
          if (!set) return;
          for (const fn of set) (fn as (d: unknown) => void)(data);
        }),
    );

    conn.connect();

    return () => {
      offState();
      offResync();
      for (const off of offChannels) off();
      conn.close();
      connRef.current = null;
    };
  }, [projectId]);

  const value = useMemo<LiveContextValue>(
    () => ({
      state,
      subscribe: (channel, fn) => {
        let set = handlers.current.get(channel);
        if (!set) {
          set = new Set();
          handlers.current.set(channel, set);
        }
        const typed = fn as unknown as (data: never) => void;
        set.add(typed);
        return () => {
          set?.delete(typed);
        };
      },
      onResync: (fn) => {
        resyncHandlers.current.add(fn);
        return () => {
          resyncHandlers.current.delete(fn);
        };
      },
    }),
    [state],
  );

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveContextValue {
  const ctx = useContext(LiveContext);
  if (!ctx) throw new Error('useLive must be used inside <LiveProvider>');
  return ctx;
}

/**
 * Subscribe to one channel for the lifetime of a component.
 *
 * The callback is kept in a ref so passing an inline arrow function does not
 * resubscribe on every render — which would otherwise churn a Set entry per
 * frame on a busy feed.
 */
export function useChannel<C extends Channel>(
  channel: C,
  fn: (data: ChannelPayload[C]) => void,
): void {
  const { subscribe } = useLive();
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(
    () => subscribe(channel, (data) => fnRef.current(data)),
    [channel, subscribe],
  );
}

/** Run something after every reconnect — normally a `/live/pulse` refetch. */
export function useResync(fn: () => void): void {
  const { onResync } = useLive();
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => onResync(() => fnRef.current()), [onResync]);
}
