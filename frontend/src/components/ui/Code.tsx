import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import s from './Code.module.css';

/**
 * Copy to clipboard, with the confirmation the user needs to believe it worked.
 *
 * `navigator.clipboard` requires a secure context and can be refused outright,
 * so there is a fallback and a failure path. Silently doing nothing on click is
 * the worst outcome here: the user walks away thinking they have the API key.
 */
export function useCopy(): {
  copied: boolean;
  failed: boolean;
  copy: (text: string) => void;
} {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const flash = useCallback((ok: boolean) => {
    setCopied(ok);
    setFailed(!ok);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setCopied(false);
      setFailed(false);
    }, 1800);
  }, []);

  const copy = useCallback(
    (text: string) => {
      const legacy = () => {
        // execCommand is deprecated but still the only option on http:// and
        // in a few embedded browsers. It is the fallback, never the first try.
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          document.body.removeChild(ta);
          flash(ok);
        } catch {
          flash(false);
        }
      };

      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(() => flash(true), legacy);
      } else {
        legacy();
      }
    },
    [flash],
  );

  return { copied, failed, copy };
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const { copied, failed, copy } = useCopy();
  return (
    <button
      type="button"
      className={[s.copyBtn, copied ? s.copied : ''].filter(Boolean).join(' ')}
      onClick={() => copy(value)}
      aria-label={`${label} to clipboard`}
    >
      <Icon name={copied ? 'check' : 'copy'} size={12} strokeWidth={copied ? 2.5 : 1.6} />
      {copied ? 'Copied' : failed ? 'Press ⌘C' : label}
    </button>
  );
}

/** One identifier or key, inline and copyable. */
export function InlineCode({
  value,
  copyable = true,
  display,
}: {
  value: string;
  copyable?: boolean;
  /** A shortened form to show while copying the full value. */
  display?: string;
}) {
  return (
    <span className={s.inline}>
      <span className={s.inlineValue} title={value}>
        {display ?? value}
      </span>
      {copyable && <CopyButton value={value} label="" />}
    </span>
  );
}

/**
 * A secret the user needs to use but should not leave on screen.
 *
 * Masked by default, revealable, and copyable WITHOUT revealing — the common
 * case is pasting it into a config file, which needs no reveal at all.
 */
export function SecretValue({ value }: { value: string }) {
  const [shown, setShown] = useState(false);
  return (
    <span className={s.inline}>
      <span className={shown ? s.inlineValue : `${s.inlineValue} ${s.masked}`}>
        {shown ? value : '•'.repeat(Math.min(value.length, 28))}
      </span>
      <button
        type="button"
        className={s.copyBtn}
        onClick={() => setShown((v) => !v)}
        aria-label={shown ? 'Hide value' : 'Show value'}
      >
        {shown ? 'Hide' : 'Show'}
      </button>
      <CopyButton value={value} label="" />
    </span>
  );
}

export interface CodeBlockProps {
  code: string;
  title?: string;
  /** Hidden from assistive tech when the code is purely illustrative. */
  children?: ReactNode;
}

export function CodeBlock({ code, title }: CodeBlockProps) {
  return (
    <div className={s.block}>
      {(title || true) && (
        <div className={s.head}>
          <span className={s.title}>{title ?? 'Request'}</span>
          <CopyButton value={code} />
        </div>
      )}
      <pre className={s.pre}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export interface CodeTab {
  id: string;
  label: string;
  code: string;
}

/** One example in several languages. Used on the API integration page. */
export function CodeTabs({ tabs }: { tabs: readonly CodeTab[] }) {
  const [active, setActive] = useState(tabs[0]?.id ?? '');
  const current = tabs.find((t) => t.id === active) ?? tabs[0];
  if (!current) return null;

  return (
    <div className={s.block}>
      <div className={s.head}>
        <div className={s.tabs} role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === current.id}
              className={[s.tab, t.id === current.id ? s.tabActive : ''].filter(Boolean).join(' ')}
              onClick={() => setActive(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <CopyButton value={current.code} />
      </div>
      <pre className={s.pre}>
        <code>{current.code}</code>
      </pre>
    </div>
  );
}
