import { useCallback, useEffect, useRef, useState } from 'react';
import { getToken } from '@/api/client';
import { aiApi } from '@/api/endpoints';

/**
 * The schema-design agent, over the project WebSocket.
 *
 * Streaming is real: the socket delivers the reply token by token. Each delta
 * updates the visible message AND is scanned for completed §directive lines,
 * which are applied to the builder the instant they finish — so the schema fills
 * live while the agent is still typing.
 *
 * The directives are a line-oriented mini-language, not JSON, precisely so this
 * incremental apply is possible: a JSON block only means anything once it is
 * whole, but a §line means something the moment its newline arrives.
 */

const WS_BASE = (import.meta.env.VITE_WS_BASE ?? '').replace(/\/$/, '');

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  /** Prose only — directives are stripped out for display. */
  content: string;
  /** Short labels of what this message changed, e.g. "+ inventory". */
  applied?: string[];
}

export type Directive =
  | { kind: 'field'; id: string; label: string; scope: string; type: string; min?: string; max?: string }
  | { kind: 'rm'; id: string }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'type'; id: string; value: string }
  | { kind: 'scope'; id: string; value: string }
  | { kind: 'product'; itemId: string; name: string; basePrice: string; cost: string; signals: Record<string, string> }
  | { kind: 'rmproduct'; id: string }
  | { kind: 'ready' };

function parseDirective(line: string): Directive | null {
  const l = line.trim();
  if (!l.startsWith('§')) return null;
  const body = l.slice(1).trim();
  const colon = body.indexOf(':');
  const verb = (colon >= 0 ? body.slice(0, colon) : body).trim().toLowerCase();
  const rest = colon >= 0 ? body.slice(colon + 1).trim() : '';

  if (verb === 'ready') return { kind: 'ready' };
  if (verb === 'field') {
    const [id, label, scope, type, min, max] = rest.split('|').map((x) => x.trim());
    if (!id) return null;
    return {
      kind: 'field',
      id,
      label: label || id,
      scope: (scope || 'item').toLowerCase(),
      type: (type || 'number').toLowerCase(),
      min: min || undefined,
      max: max || undefined,
    };
  }
  if (verb === 'rm') return rest ? { kind: 'rm', id: rest.trim() } : null;
  if (verb === 'rename') {
    const [from, to] = rest.split('>').map((x) => x.trim());
    return from && to ? { kind: 'rename', from, to } : null;
  }
  if (verb === 'type') {
    const [id, value] = rest.split('>').map((x) => x.trim());
    return id && value ? { kind: 'type', id, value: value.toLowerCase() } : null;
  }
  if (verb === 'scope') {
    const [id, value] = rest.split('>').map((x) => x.trim());
    return id && value ? { kind: 'scope', id, value: value.toLowerCase() } : null;
  }
  if (verb === 'product') {
    const [itemId, name, basePrice, cost, sigStr] = rest.split('|').map((x) => x.trim());
    if (!itemId) return null;
    const signals: Record<string, string> = {};
    for (const pair of (sigStr || '').split(',')) {
      const [k, v] = pair.split('=').map((x) => x.trim());
      if (k && v !== undefined) signals[k] = v;
    }
    return {
      kind: 'product',
      itemId,
      name: name || itemId,
      basePrice: basePrice || '',
      cost: cost && cost !== '-' ? cost : '',
      signals,
    };
  }
  // §rmproduct: <item_id>  — or  §rmproduct: *  to clear every sample row.
  if (verb === 'rmproduct') return rest ? { kind: 'rmproduct', id: rest.trim() } : null;
  return null;
}

/**
 * Parse a schema summary ("id(scope,type), …") into an id → "scope,type" map,
 * so two summaries can be compared field by field.
 */
function parseSummary(summary: string): Map<string, string> {
  // Each field is "id(scope,type)". We can't split on "," — the meta itself
  // contains one — so match whole id(...) tokens instead.
  const map = new Map<string, string>();
  for (const m of summary.matchAll(/([A-Za-z0-9_]+)\(([^)]*)\)/g)) {
    if (m[1]) map.set(m[1].trim(), (m[2] ?? '').trim());
  }
  return map;
}

/**
 * What the USER changed by hand since the agent's last message.
 *
 * Between two agent turns the agent itself never runs, so anything that differs
 * from the snapshot taken right after its last reply is the user's own manual
 * edit. That is exactly what we hand back to the agent as context, so it knows a
 * field it is talking about was added, retyped or removed by hand — and builds
 * on it instead of silently undoing it. Empty string when nothing changed.
 */
function diffSchema(prev: string, curr: string): string {
  const a = parseSummary(prev);
  const b = parseSummary(curr);
  const added: { id: string; meta: string }[] = [];
  const removed: { id: string; meta: string }[] = [];
  const changed: string[] = [];

  for (const [id, meta] of b) {
    if (!a.has(id)) added.push({ id, meta });
    else if (a.get(id) !== meta) changed.push(`${id} (${a.get(id)} → ${meta})`);
  }
  for (const [id, meta] of a) if (!b.has(id)) removed.push({ id, meta });

  // A single remove + single add of the same kind reads as a rename — report
  // it that way so the agent keeps the field's history rather than seeing it
  // vanish and reappear as something unrelated.
  const parts: string[] = [];
  if (added.length === 1 && removed.length === 1 && added[0]!.meta === removed[0]!.meta) {
    parts.push(`renamed ${removed[0]!.id} → ${added[0]!.id}`);
  } else {
    for (const x of added) parts.push(`added ${x.id}(${x.meta})`);
    for (const x of removed) parts.push(`removed ${x.id}`);
  }
  for (const c of changed) parts.push(`changed ${c}`);
  return parts.join('; ');
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

interface AgentContext {
  projectId: string | null;
  projectName: string;
  stage: string;
  schemaSummary: () => string;
  /** Current sample rows (id + name), so the agent can delete/modify them. */
  itemsSummary?: () => string;
  onDirective: (d: Directive) => string | null;
}

export function useSchemaAgent(ctx: AgentContext) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const rawRef = useRef('');            // the live assistant text as it streams
  const appliedRef = useRef(0);          // how many §lines already applied
  const appliedLabelsRef = useRef<string[]>([]);
  const loadedRef = useRef(false);       // history fetched for this project
  // The schema snapshot as it stood right after the agent's last reply. The
  // diff against the live schema at send time is exactly the user's manual
  // edits since then. Null until the first turn, so pre-existing fields are
  // never mislabelled as "just added by hand".
  const baselineRef = useRef<string | null>(null);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  // Load the stored transcript once a project exists, so reopening the wizard
  // shows the whole earlier conversation. The thread is tied to the project,
  // not this tab — the backend persists every turn. Runs before (and
  // independently of) the socket; a failed fetch just leaves the greeting.
  useEffect(() => {
    const pid = ctx.projectId;
    if (!pid || loadedRef.current) return;
    loadedRef.current = true;
    let cancelled = false;
    aiApi
      .chatHistory(pid)
      .then((res) => {
        if (cancelled || !res.messages?.length) return;
        const restored: ChatMessage[] = res.messages.map((m) => ({
          role: m.role,
          // Assistant turns are stored raw (directives included) — strip them
          // for display exactly as the streaming path does.
          content: m.role === 'assistant' ? prose(m.content) : m.content,
          applied: m.applied,
        }));
        setMessages(restored);
      })
      .catch(() => {
        /* no stored history, or offline — the greeting stands in */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.projectId]);

  // Open the socket once a project exists. The wizard lives outside the app
  // shell's LiveProvider, so the agent owns its own connection.
  useEffect(() => {
    const token = getToken();
    if (!ctx.projectId || !token || !WS_BASE) return;
    const url = `${WS_BASE}?token=${encodeURIComponent(token)}&project_id=${ctx.projectId}&channels=none`;
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
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.type === 'agent_start') {
        rawRef.current = '';
        appliedRef.current = 0;
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
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: m.message ?? 'The assistant is unavailable right now.' },
        ]);
      }
    };
    return () => {
      wsRef.current = null;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.projectId]);

  const applyNewDirectives = () => {
    const raw = rawRef.current;
    const lines = raw.split('\n');
    const completeCount = raw.endsWith('\n') ? lines.length : lines.length - 1;
    const dirLines = lines.slice(0, completeCount).filter((l) => l.trim().startsWith('§'));
    for (let i = appliedRef.current; i < dirLines.length; i += 1) {
      const d = parseDirective(dirLines[i]!);
      if (!d) continue;
      if (d.kind === 'ready') {
        setReady(true);
        continue;
      }
      const label = ctxRef.current.onDirective(d);
      if (label) appliedLabelsRef.current.push(label);
    }
    appliedRef.current = dirLines.length;
  };

  const updateLiveMessage = () => {
    const text = prose(rawRef.current);
    setMessages((prev) => {
      const copy = [...prev];
      const last = copy[copy.length - 1];
      if (last && last.role === 'assistant' && (last as { streaming?: boolean }).streaming) {
        copy[copy.length - 1] = { ...last, content: text };
      } else {
        copy.push({ role: 'assistant', content: text, ...{ streaming: true } } as ChatMessage);
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
      if (last && last.role === 'assistant') {
        copy[copy.length - 1] = { role: 'assistant', content: text, applied: applied.length ? applied : undefined };
      } else {
        copy.push({ role: 'assistant', content: text, applied: applied.length ? applied : undefined });
      }
      return copy;
    });
    setStreaming(false);
    // The schema now reflects the agent's own directives too — rebase, so only
    // the user's subsequent manual edits count as "manual" next turn.
    baselineRef.current = ctxRef.current.schemaSummary();
  };

  const send = useCallback((text: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !text.trim()) return;
    const userMsg: ChatMessage = { role: 'user', content: text.trim() };
    setMessages((prev) => [...prev, userMsg]);
    const history = [...messagesRef.current, userMsg].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // Attribute any manual schema edits made since the agent last spoke, so it
    // knows what the user changed by hand. First turn just seeds the baseline.
    const snapshot = ctxRef.current.schemaSummary();
    const manualChanges =
      baselineRef.current === null ? '' : diffSchema(baselineRef.current, snapshot);
    if (baselineRef.current === null) baselineRef.current = snapshot;

    ws.send(
      JSON.stringify({
        action: 'agent',
        project_name: ctxRef.current.projectName,
        stage: ctxRef.current.stage,
        schema_summary: snapshot,
        manual_changes: manualChanges,
        items_summary: ctxRef.current.itemsSummary?.() ?? '',
        history,
      }),
    );
  }, []);

  // Keep a ref of messages for building history without re-creating `send`.
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;

  const seedGreeting = useCallback((greeting: string) => {
    setMessages((prev) => (prev.length === 0 ? [{ role: 'assistant', content: greeting }] : prev));
  }, []);

  return { messages, streaming, connected, ready, send, seedGreeting };
}
