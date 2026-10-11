import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { cx } from '@/lib/cx';
import { useProjectAgent, type AgentMessage } from '@/hooks/useProjectAgent';
import s from '@/components/wizard/SchemaAgent.module.css';

/**
 * The in-project assistant panel — one instance, mounted in the app shell.
 *
 * It reuses the wizard assistant's look (same CSS module) because it is, to the
 * user, the same assistant continuing after the project is built. It can write
 * rules, set limits, build test cases and answer questions, switching tabs
 * itself as it goes. The heavy lifting lives in `useProjectAgent`; this is just
 * the chat surface.
 */
export function ProjectAgent() {
  const agent = useProjectAgent();
  const [draft, setDraft] = useState('');
  const [calloutDismissed, setCalloutDismissed] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [agent.messages, agent.streaming]);

  if (!agent.available) return null;

  const submit = () => {
    if (!draft.trim() || agent.streaming) return;
    agent.send(draft);
    setDraft('');
  };

  const empty = agent.messages.length === 0;

  return (
    <>
      {!agent.open && (
        <div className={s.launcher}>
          {!calloutDismissed && (
            <button type="button" className={s.callout} onClick={() => agent.setOpen(true)}>
              Need help? Ask me anything ✨
              <span
                className={s.calloutDismiss}
                role="button"
                aria-label="Dismiss"
                onClick={(e) => {
                  e.stopPropagation();
                  setCalloutDismissed(true);
                }}
              >
                ×
              </span>
            </button>
          )}
          <button type="button" className={s.bubble} onClick={() => agent.setOpen(true)} aria-label="Open assistant">
            <span className={s.bubbleGlow} aria-hidden="true" />
            <Icon name="sparkle" size={22} />
          </button>
        </div>
      )}

      {agent.open && (
        <div className={s.panel} role="dialog" aria-label="Project assistant">
          <header className={s.head}>
            <span className={s.headTitle}>
              <span className={s.avatar}><Icon name="sparkle" size={14} /></span>
              DevNexus
              <span className={cx(s.dot, agent.connected ? s.dotOn : s.dotOff)} />
            </span>
            <button type="button" className={s.close} onClick={() => agent.setOpen(false)} aria-label="Close">
              <Icon name="chevron-down" size={16} />
            </button>
          </header>

          <div className={s.messages} ref={listRef}>
            {empty && (
              <Bubble m={{
                role: 'assistant',
                content:
                  "Hi 👋 I'm here for the whole project.\nAsk me to **write rules**, **set limits**, **build test cases**, or **explain your analytics** — I'll switch to the right tab and do it with you.",
              }} />
            )}
            {agent.messages.map((m, i) => <Bubble key={i} m={m} />)}
            {agent.streaming && agent.messages[agent.messages.length - 1]?.role !== 'assistant' && (
              <div className={cx(s.msg, s.msgAssistant)}><Typing /></div>
            )}
          </div>

          <div className={s.composer}>
            <textarea
              className={s.input}
              rows={1}
              value={draft}
              placeholder="Ask about rules, limits, tests, analytics…"
              disabled={!agent.connected}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <button
              type="button"
              className={s.send}
              disabled={!draft.trim() || agent.streaming || !agent.connected}
              onClick={submit}
              aria-label="Send"
            >
              <Icon name={agent.streaming ? 'spinner' : 'arrow-up'} size={16} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function Bubble({ m }: { m: AgentMessage }) {
  return (
    <div className={cx(s.msg, m.role === 'user' ? s.msgUser : s.msgAssistant)}>
      <div className={s.msgText}>{renderRich(m.content)}</div>
      {m.applied && m.applied.length > 0 && (
        <div className={s.applied}>
          {m.applied.map((a, i) => (
            <span key={i} className={s.appliedChip}>
              <Icon name="check" size={10} strokeWidth={3} />
              {a}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Typing() {
  return <span className={s.typing}><span /><span /><span /></span>;
}

function renderRich(text: string) {
  return text.split('\n').map((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return <div key={i} className={s.gap} />;
    const bullet = /^[•\-*]\s+/.test(trimmed);
    const content = bullet ? trimmed.replace(/^[•\-*]\s+/, '') : trimmed;
    return (
      <div key={i} className={bullet ? s.bullet : undefined}>
        {bullet && <span className={s.bulletDot}>•</span>}
        <span>{renderBold(content)}</span>
      </div>
    );
  });
}

function renderBold(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.startsWith('`') && p.endsWith('`')) return <code key={i} className={s.code}>{p.slice(1, -1)}</code>;
    return <span key={i}>{p}</span>;
  });
}
