import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { cx } from '@/lib/cx';
import { useSchemaAgent, type ChatMessage, type Directive } from '@/hooks/useSchemaAgent';
import s from './SchemaAgent.module.css';

/**
 * The floating schema-design assistant.
 *
 * A bubble that opens a chat. The agent streams its reply token by token and
 * fills the builder live through `onDirective`. It is a co-pilot, not a
 * replacement — the manual fields stay fully editable, and every change the
 * agent makes lands in the same state the manual UI drives.
 */
export function SchemaAgent({
  projectId,
  projectName,
  stage,
  schemaSummary,
  itemsSummary,
  onDirective,
}: {
  projectId: string | null;
  projectName: string;
  stage: 'schema' | 'products';
  schemaSummary: () => string;
  itemsSummary?: () => string;
  onDirective: (d: Directive) => string | null;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [calloutDismissed, setCalloutDismissed] = useState(false);

  const agent = useSchemaAgent({ projectId, projectName, stage, schemaSummary, itemsSummary, onDirective });

  // Greet once, with no API call — the model only runs when the user describes.
  useEffect(() => {
    if (open) {
      agent.seedGreeting(
        stage === 'products'
          ? `Hi again 👋 Want me to add some sample ${'products'} so you have data to test with? Just say **yes**, or tell me roughly what you sell.`
          : `Hi, I'm **DevNexus** 👋\nTell me what you're pricing and what makes the price move — I'll design the schema with you.`,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stage]);

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [agent.messages, agent.streaming]);

  const submit = () => {
    if (!draft.trim() || agent.streaming) return;
    agent.send(draft);
    setDraft('');
  };

  if (!projectId) return null;

  return (
    <>
      {!open && (
        <div className={s.launcher}>
          {!calloutDismissed && (
            <button
              type="button"
              className={s.callout}
              onClick={() => setOpen(true)}
            >
              {stage === 'products'
                ? 'Want me to add some sample data? ✨'
                : 'Want me to help design your schema? ✨'}
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
          <button type="button" className={s.bubble} onClick={() => setOpen(true)} aria-label="Design with AI">
            <span className={s.bubbleGlow} aria-hidden="true" />
            <Icon name="sparkle" size={22} />
          </button>
        </div>
      )}

      {open && (
        <div className={s.panel} role="dialog" aria-label="Schema assistant">
          <header className={s.head}>
            <span className={s.headTitle}>
              <span className={s.avatar}>
                <Icon name="sparkle" size={14} />
              </span>
              DevNexus
              <span className={cx(s.dot, agent.connected ? s.dotOn : s.dotOff)} />
            </span>
            <button type="button" className={s.close} onClick={() => setOpen(false)} aria-label="Close">
              <Icon name="chevron-down" size={16} />
            </button>
          </header>

          <div className={s.messages} ref={listRef}>
            {agent.messages.map((m, i) => (
              <Bubble key={i} m={m} />
            ))}
            {agent.streaming && agent.messages[agent.messages.length - 1]?.role !== 'assistant' && (
              <div className={cx(s.msg, s.msgAssistant)}>
                <Typing />
              </div>
            )}
          </div>

          <div className={s.composer}>
            <textarea
              className={s.input}
              rows={1}
              value={draft}
              placeholder="Describe what you price…"
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

function Bubble({ m }: { m: ChatMessage }) {
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
  return (
    <span className={s.typing}>
      <span />
      <span />
      <span />
    </span>
  );
}

/**
 * A tiny, safe inline renderer: **bold**, bullet lines, blank-line spacing.
 * No HTML is ever injected — everything is built as React nodes.
 */
function renderRich(text: string) {
  const lines = text.split('\n');
  return lines.map((line, i) => {
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
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.startsWith('`') && p.endsWith('`')) return <code key={i} className={s.code}>{p.slice(1, -1)}</code>;
    return <span key={i}>{p}</span>;
  });
}
