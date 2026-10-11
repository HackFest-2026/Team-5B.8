import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getToken } from '@/api/client';
import { aiApi, analyticsApi, projectsApi, rulesApi } from '@/api/endpoints';
import { useSession } from '@/hooks/useSession';

/**
 * The in-project assistant: one agent, mounted once in the app shell, that
 * lives for the whole project.
 *
 * It is the same conversation the creation wizard started — persisted per
 * project — now continuing inside the project. It streams over the project
 * WebSocket, and unlike a per-page helper it can DRIVE the app: a §goto
 * directive switches tabs, and the directives that follow are routed to
 * whichever page is open (each page registers a handler with
 * `useAgentSurface`). Directives that arrive before their page has mounted are
 * buffered and flushed on registration, so "switch to Rules, then fill them"
 * works even though the navigation is asynchronous.
 */

const WS_BASE = (import.meta.env.VITE_WS_BASE ?? '').replace(/\/$/, '');

export type ChatRole = 'user' | 'assistant';

export interface AgentMessage {
  role: ChatRole;
  content: string;
  applied?: string[];
}

/** Which tab a surface name maps to. The agent speaks in surfaces, not URLs. */
const SURFACE_ROUTE: Record<string, string> = {
  overview: '/app/project',
  analytics: '/app/analytics',
  alerts: '/app/alerts',
  items: '/app/items',
  rules: '/app/rules',
  playground: '/app/project/playground',
  limits: '/app/project/settings',
  strategies: '/app/strategies',
  api: '/app/api',
  audit: '/app/audit',
};

/** Reverse map, so the current URL tells the agent where the user is. */
function surfaceForPath(pathname: string): string {
  const hit = Object.entries(SURFACE_ROUTE).find(([, route]) =>
    route === '/app/project'
      ? pathname === route
      : pathname === route || pathname.startsWith(`${route}/`),
  );
  return hit ? hit[0] : 'overview';
}

export type AgentDirective =
  | { kind: 'goto'; surface: string }
  | {
      kind: 'rule';
      name: string;
      clauses: { field: string; op: string; value: string }[];
      percent: string;
      reason?: string;
    }
  | { kind: 'limit'; up?: string; down?: string; margin?: string }
  | { kind: 'testcase'; title: string; itemId: string; signals: Record<string, string>; expected?: string }
  | { kind: 'rmrule'; name: string }
  | { kind: 'ready' };

/** A page's handler returns a short label of what it applied, or null. */
export type SurfaceHandler = (d: AgentDirective) => string | null;

function parseDirective(line: string): AgentDirective | null {
  const l = line.trim();
  if (!l.startsWith('§')) return null;
  const body = l.slice(1).trim();
  const colon = body.indexOf(':');
  const verb = (colon >= 0 ? body.slice(0, colon) : body).trim().toLowerCase();
  const rest = colon >= 0 ? body.slice(colon + 1).trim() : '';

  if (verb === 'ready') return { kind: 'ready' };
  if (verb === 'goto') return rest ? { kind: 'goto', surface: rest.toLowerCase() } : null;

  if (verb === 'rule') {
    const [name, cond, pct, reason] = rest.split('|').map((x) => x.trim());
    if (!name || !cond || !pct) return null;
    const clauses = cond.split('&').map((c) => {
      const m = c.trim().match(/^(\S+)\s*(>=|<=|==|!=|>|<)\s*(.+)$/);
      return m ? { field: m[1]!, op: m[2]!, value: (m[3] ?? '').trim() } : null;
    }).filter(Boolean) as { field: string; op: string; value: string }[];
    if (!clauses.length) return null;
    return { kind: 'rule', name, clauses, percent: pct, reason: reason || undefined };
  }
  if (verb === 'limit') {
    const out: { up?: string; down?: string; margin?: string } = {};
    for (const m of rest.matchAll(/(up|down|margin)\s*=\s*(-?\d+(?:\.\d+)?)/gi)) {
      out[m[1]!.toLowerCase() as 'up' | 'down' | 'margin'] = m[2]!;
    }
    return Object.keys(out).length ? { kind: 'limit', ...out } : null;
  }
  if (verb === 'rmrule') return rest ? { kind: 'rmrule', name: rest.trim() } : null;
  if (verb === 'testcase') {
    const [title, itemId, sigStr, expected] = rest.split('|').map((x) => x.trim());
    if (!title || !itemId) return null;
    const signals: Record<string, string> = {};
    for (const pair of (sigStr || '').split(',')) {
      const [k, v] = pair.split('=').map((x) => x.trim());
      if (k && v !== undefined) signals[k] = v;
    }
    return { kind: 'testcase', title, itemId, signals, expected: expected || undefined };
  }
  return null;
}

/** Everything but the directive lines, for display. */
function prose(raw: string): string {
  return raw
    .split('\n')
    .filter((l) => !l.trim().startsWith('§'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface ProjectAgentValue {
  available: boolean;
  open: boolean;
  setOpen: (v: boolean) => void;
  messages: AgentMessage[];
  streaming: boolean;
  connected: boolean;
  send: (text: string) => void;
  /** A page registers its directive handler; returns an unregister fn. */
  registerSurface: (surface: string, handler: SurfaceHandler) => () => void;
}

const Ctx = createContext<ProjectAgentValue | null>(null);

export function ProjectAgentProvider({ children }: { children: ReactNode }) {
  const { project, projectId } = useSession();
  const navigate = useNavigate();
  const location = useLocation();

  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [connected, setConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const rawRef = useRef('');
  const appliedCountRef = useRef(0);
  const appliedLabelsRef = useRef<string[]>([]);
  const loadedRef = useRef<string | null>(null);

  // Page handlers + a buffer for directives that arrive before their page is
  // mounted. `targetSurface` is set by the most recent §goto.
  const handlersRef = useRef<Map<string, SurfaceHandler>>(new Map());
  const bufferRef = useRef<Map<string, AgentDirective[]>>(new Map());
  const targetSurfaceRef = useRef<string>('overview');

  // The session carries only a project SUMMARY (no schema/guardrails), so the
  // field vocabulary and limits — which the agent needs to write valid, in-limit
  // rules — are fetched once per project.
  const projectName = project?.name ?? '';
  const [schemaSummary, setSchemaSummary] = useState('');
  const [guardrailSummary, setGuardrailSummary] = useState('');
  const [analyticsSummary, setAnalyticsSummary] = useState('');
  const [rulesSummary, setRulesSummary] = useState('');

  // The current rules, so the agent sees exactly what exists — to DELETE
  // duplicates/conflicts rather than pile on more, and to avoid re-creating one
  // that is already there. Refreshed whenever the panel opens.
  useEffect(() => {
    if (!projectId || !open) return;
    let cancelled = false;
    rulesApi
      .list(projectId, true)
      .then((res) => {
        if (cancelled) return;
        setRulesSummary(
          (res.rules ?? [])
            .map((r) => {
              const c = r.clauses?.[0];
              const cond = c ? `${c.field} ${c.operator} ${c.value}` : '';
              const a = r.adjustment;
              const act = a?.type === 'formula'
                ? 'formula'
                : `${a?.direction === 'decrease' ? '-' : '+'}${a?.value}%`;
              return `${r.name} [${cond} -> ${act}]${r.enabled === false ? ' (off)' : ''}`;
            })
            .join('; '),
        );
      })
      .catch(() => { /* no rules or offline */ });
    return () => { cancelled = true; };
  }, [projectId, open]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    projectsApi
      .get(projectId)
      .then((res) => {
        if (cancelled) return;
        const sigs = res.schema?.context_signals ?? [];
        setSchemaSummary(
          sigs
            .map((sg) => {
              const scope = (sg as { scope?: string }).scope ?? 'item';
              return `${sg.id}(${scope},${sg.type ?? 'number'})`;
            })
            .join(', '),
        );
        const g = res.guardrails;
        setGuardrailSummary(
          g ? `max_increase=${g.max_increase_pct}% max_decrease=${g.max_decrease_pct}%` : '',
        );
      })
      .catch(() => { /* fall back to empty vocabulary */ });
    return () => { cancelled = true; };
  }, [projectId]);

  // A compact KPI snapshot so the agent can answer analytics questions from
  // real numbers rather than making them up. Refreshed when the panel opens, so
  // an answer reflects what the user is looking at.
  useEffect(() => {
    if (!projectId || !open) return;
    let cancelled = false;
    analyticsApi
      .overview(projectId)
      .then((res) => {
        if (cancelled) return;
        const k = res.kpis;
        const c = res.currency || '';
        setAnalyticsSummary(
          `revenue=${c}${k.revenue.value} (${k.revenue.change_pct ?? 0}%), ` +
          `margin=${c}${k.margin.value} (${k.margin.percent}%), ` +
          `orders=${k.orders.value}, avg_price=${c}${k.avg_price.value}, ` +
          `decisions=${k.decisions.value}, price_change_rate=${k.price_changes.rate_pct}%, ` +
          `guardrail_blocks=${res.safety.guardrail_blocks}, healthy=${res.safety.healthy}`,
        );
      })
      .catch(() => { /* analytics optional — agent still answers other things */ });
    return () => { cancelled = true; };
  }, [projectId, open]);

  const currentSurface = surfaceForPath(location.pathname);
  const surfaceRef = useRef(currentSurface);
  surfaceRef.current = currentSurface;
  const ctxDataRef = useRef({ projectName, schemaSummary, guardrailSummary, analyticsSummary, rulesSummary });
  ctxDataRef.current = { projectName, schemaSummary, guardrailSummary, analyticsSummary, rulesSummary };

  const dispatch = useCallback((d: AgentDirective) => {
    if (d.kind === 'ready') return;
    if (d.kind === 'goto') {
      targetSurfaceRef.current = d.surface;
      const route = SURFACE_ROUTE[d.surface];
      if (route) navigate(route);
      return;
    }
    // Route to the page the agent most recently navigated to. If that page has
    // not registered yet (navigation is async), buffer until it does.
    const surface = targetSurfaceRef.current;
    const handler = handlersRef.current.get(surface);
    if (handler) {
      const label = handler(d);
      if (label) appliedLabelsRef.current.push(label);
    } else {
      const buf = bufferRef.current.get(surface) ?? [];
      buf.push(d);
      bufferRef.current.set(surface, buf);
    }
  }, [navigate]);

  const registerSurface = useCallback((surface: string, handler: SurfaceHandler) => {
    handlersRef.current.set(surface, handler);
    const pending = bufferRef.current.get(surface);
    if (pending?.length) {
      for (const d of pending) {
        const label = handler(d);
        if (label) appliedLabelsRef.current.push(label);
      }
      bufferRef.current.delete(surface);
    }
    return () => {
      if (handlersRef.current.get(surface) === handler) handlersRef.current.delete(surface);
    };
  }, []);

  // Load the shared transcript once per project.
  useEffect(() => {
    if (!projectId || loadedRef.current === projectId) return;
    loadedRef.current = projectId;
    let cancelled = false;
    aiApi
      .chatHistory(projectId)
      .then((res) => {
        if (cancelled || !res.messages?.length) return;
        setMessages(res.messages.map((m) => ({
          role: m.role,
          content: m.role === 'assistant' ? prose(m.content) : m.content,
          applied: m.applied,
        })));
      })
      .catch(() => { /* no history yet */ });
    return () => { cancelled = true; };
  }, [projectId]);

  // Open the socket for the current project.
  useEffect(() => {
    const token = getToken();
    if (!projectId || !token || !WS_BASE) return;
    const url = `${WS_BASE}?token=${encodeURIComponent(token)}&project_id=${projectId}&channels=none`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      return;
    }
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (e) => {
      let m: { type?: string; text?: string; message?: string };
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'agent_start') {
        rawRef.current = '';
        appliedCountRef.current = 0;
        appliedLabelsRef.current = [];
        setStreaming(true);
      } else if (m.type === 'agent_delta') {
        rawRef.current += m.text ?? '';
        applyNewDirectives();
        updateLiveMessage();
      } else if (m.type === 'agent_done') {
        finalize();
      } else if (m.type === 'agent_error') {
        setStreaming(false);
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: m.message ?? 'The assistant is unavailable right now.',
        }]);
      }
    };
    return () => {
      wsRef.current = null;
      try { ws.close(); } catch { /* already closing */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const applyNewDirectives = () => {
    const raw = rawRef.current;
    const lines = raw.split('\n');
    const complete = raw.endsWith('\n') ? lines.length : lines.length - 1;
    const dirLines = lines.slice(0, complete).filter((l) => l.trim().startsWith('§'));
    for (let i = appliedCountRef.current; i < dirLines.length; i += 1) {
      const d = parseDirective(dirLines[i]!);
      if (d) dispatch(d);
    }
    appliedCountRef.current = dirLines.length;
  };

  const updateLiveMessage = () => {
    const text = prose(rawRef.current);
    setMessages((prev) => {
      const copy = [...prev];
      const last = copy[copy.length - 1];
      if (last && last.role === 'assistant' && (last as { streaming?: boolean }).streaming) {
        copy[copy.length - 1] = { ...last, content: text };
      } else {
        copy.push({ role: 'assistant', content: text, ...{ streaming: true } } as AgentMessage);
      }
      return copy;
    });
  };

  const finalize = () => {
    applyNewDirectives();
    const text = prose(rawRef.current);
    const applied = [...appliedLabelsRef.current];
    setMessages((prev) => {
      const copy = [...prev];
      const last = copy[copy.length - 1];
      const msg: AgentMessage = {
        role: 'assistant', content: text, applied: applied.length ? applied : undefined,
      };
      if (last && last.role === 'assistant') copy[copy.length - 1] = msg;
      else copy.push(msg);
      return copy;
    });
    setStreaming(false);
  };

  const messagesRef = useRef<AgentMessage[]>([]);
  messagesRef.current = messages;

  const send = useCallback((text: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !text.trim()) return;
    const userMsg: AgentMessage = { role: 'user', content: text.trim() };
    setMessages((prev) => [...prev, userMsg]);
    const history = [...messagesRef.current, userMsg].map((m) => ({ role: m.role, content: m.content }));
    const { projectName: pn, schemaSummary: ss, guardrailSummary: gs, analyticsSummary: an, rulesSummary: rs } =
      ctxDataRef.current;
    ws.send(JSON.stringify({
      action: 'agent',
      mode: 'project',
      project_name: pn,
      surface: surfaceRef.current,
      schema_summary: ss,
      guardrails: gs,
      analytics: an,
      rules: rs,
      history,
    }));
  }, []);

  // The assistant belongs INSIDE a project, never on the account dashboard or
  // account settings — there is no project there to act on.
  const isProjectRoute =
    location.pathname !== '/app' && location.pathname !== '/app/settings';

  const value = useMemo<ProjectAgentValue>(() => ({
    available: !!projectId && isProjectRoute,
    open, setOpen,
    messages, streaming, connected,
    send, registerSurface,
  }), [projectId, isProjectRoute, open, messages, streaming, connected, send, registerSurface]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProjectAgent(): ProjectAgentValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useProjectAgent must be used inside <ProjectAgentProvider>');
  return ctx;
}

/**
 * A page calls this to receive the agent's directives for its surface. The
 * handler applies each directive and returns a short label of what it did.
 */
export function useAgentSurface(surface: string, handler: SurfaceHandler): void {
  const { registerSurface } = useProjectAgent();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    return registerSurface(surface, (d) => handlerRef.current(d));
  }, [surface, registerSurface]);
}
