import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useSession } from '@/hooks/useSession';
import { useTheme } from '@/hooks/useTheme';
import { cx } from '@/lib/cx';
import { Icon, type IconName } from './ui/Icon';
import s from './CommandPalette.module.css';

/**
 * ⌘K / Ctrl-K command palette.
 *
 * Navigation, project switching and theme in one keyboard surface. It matters
 * more than it looks for a tool like this: an analyst comparing two projects
 * switches constantly, and doing that by mouse through a dropdown is three
 * actions where this is one.
 *
 * The matching is a simple subsequence test rather than a fuzzy-search library:
 * there are a few dozen commands, so "alrt" finding "Alerts" is all that is
 * needed and it costs nothing.
 */

interface Command {
  id: string;
  group: string;
  label: string;
  meta?: string;
  icon: IconName;
  run: () => void;
  /** Extra words that should match this command without being displayed. */
  keywords?: string;
}

/**
 * Subsequence match: every character of the query appears in order.
 *
 * Returns a score so better matches sort first — a prefix hit beats a match
 * whose letters are scattered, which is what makes "dec" land on "Decisions"
 * rather than "Rules, Items and Data".
 */
function score(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 1000;
  const direct = t.indexOf(q);
  if (direct >= 0) return 500 - direct;

  let qi = 0;
  let gaps = 0;
  let last = -1;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      if (last >= 0) gaps += i - last - 1;
      last = i;
      qi++;
    }
  }
  return qi === q.length ? Math.max(1, 100 - gaps) : 0;
}

export function CommandPalette() {
  const navigate = useNavigate();
  const { projects, project, selectProject, signOut } = useSession();
  const { theme, setPreference } = useTheme();

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  /* ── the global shortcut ───────────────────────────────────────────── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      // `/` is the other convention, but only when not already typing into a
      // field — otherwise it would hijack every search box in the app.
      if (e.key === '/' && !open) {
        const el = document.activeElement;
        const typing =
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement ||
          el instanceof HTMLSelectElement ||
          (el as HTMLElement | null)?.isContentEditable;
        if (!typing) {
          e.preventDefault();
          setOpen(true);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    // Focus after paint, or the browser may focus the element before the portal
    // is attached and the first keystroke is lost.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  const close = useCallback(() => setOpen(false), []);

  const go = useCallback(
    (path: string) => () => {
      close();
      navigate(path);
    },
    [close, navigate],
  );

  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = [
      { id: 'overview', group: 'Go to', label: 'Dashboard', icon: 'overview', run: go('/app'), keywords: 'home account status' },
      { id: 'project', group: 'Go to', label: 'Project dashboard', icon: 'analytics', run: go('/app/project'), keywords: 'live decisions realtime stream replay verify explain why' },
      { id: 'items', group: 'Go to', label: 'Items', icon: 'projects', run: go('/app/items'), keywords: 'products rooms' },
      { id: 'rules', group: 'Go to', label: 'Rules', icon: 'rules', run: go('/app/rules') },
      { id: 'strategies', group: 'Go to', label: 'Strategies', icon: 'strategies', run: go('/app/strategies') },
      { id: 'data', group: 'Go to', label: 'Data', icon: 'data', run: go('/app/data'), keywords: 'upload csv history' },
      { id: 'simulation', group: 'Go to', label: 'Simulation', icon: 'simulation', run: go('/app/simulation'), keywords: 'what-if backtest shadow test' },
      { id: 'analytics', group: 'Go to', label: 'Analytics', icon: 'analytics', run: go('/app/analytics'), keywords: 'charts revenue' },
      { id: 'alerts', group: 'Go to', label: 'Alerts', icon: 'alerts', run: go('/app/alerts'), keywords: 'approvals warnings' },
      { id: 'audit', group: 'Go to', label: 'Audit', icon: 'audit', run: go('/app/audit'), keywords: 'history log who changed' },
      { id: 'api', group: 'Go to', label: 'API', icon: 'api', run: go('/app/api'), keywords: 'key integration endpoint curl' },
      { id: 'settings', group: 'Go to', label: 'Account settings', icon: 'settings', run: go('/app/settings'), keywords: 'theme company email account' },
      { id: 'playground', group: 'Go to', label: 'Playground', icon: 'simulation', run: go('/app/project/playground'), keywords: 'test simulate cases try safe' },
      { id: 'project-settings', group: 'Go to', label: 'Guardrails', icon: 'shield', run: go('/app/project/settings'), keywords: 'limits safety floor ceiling margin' },
    ];

    const actions: Command[] = [
      { id: 'new-project', group: 'Create', label: 'New project', icon: 'plus', run: go('/app/projects/new') },
      { id: 'new-rule', group: 'Create', label: 'New rule', icon: 'rules', run: go('/app/rules'), keywords: 'add condition' },
      { id: 'describe-rule', group: 'Create', label: 'Describe a rule for me', icon: 'sparkle', run: go('/app/rules'), keywords: 'ai draft natural language' },
    ];

    // Only offer a switch to a project the user is not already on.
    const switches: Command[] = projects
      .filter((p) => p.project_id !== project?.project_id)
      .map((p) => ({
        id: `switch-${p.project_id}`,
        group: 'Switch project',
        label: p.name,
        meta: `${p.domain_name} · ${p.mode}`,
        icon: 'projects' as IconName,
        run: () => {
          close();
          selectProject(p.project_id);
        },
      }));

    const prefs: Command[] = [
      {
        id: 'theme',
        group: 'Preferences',
        label: theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
        icon: theme === 'dark' ? 'sun' : 'moon',
        run: () => {
          close();
          setPreference(theme === 'dark' ? 'light' : 'dark');
        },
        keywords: 'theme appearance',
      },
      {
        id: 'signout',
        group: 'Preferences',
        label: 'Sign out',
        icon: 'logout',
        run: () => {
          close();
          signOut();
          navigate('/', { replace: true });
        },
      },
    ];

    return [...nav, ...actions, ...switches, ...prefs];
  }, [projects, project, go, close, selectProject, theme, setPreference, signOut, navigate]);

  const results = useMemo(() => {
    const scored = commands
      .map((c) => ({ c, n: Math.max(score(query, c.label), score(query, c.keywords ?? '') * 0.7) }))
      .filter((r) => r.n > 0)
      .sort((a, b) => b.n - a.n);
    return scored.slice(0, 12).map((r) => r.c);
  }, [commands, query]);

  // Clamp the cursor when the result list shrinks under it.
  useEffect(() => setCursor((c) => Math.min(c, Math.max(0, results.length - 1))), [results.length]);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [cursor, results.length]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => (results.length === 0 ? 0 : (c + 1) % results.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (results.length === 0 ? 0 : (c - 1 + results.length) % results.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      results[cursor]?.run();
    }
  };

  if (!open) return null;

  let lastGroup = '';

  return createPortal(
    <div className={s.overlay} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        className={s.panel}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
      >
        <div className={s.inputRow}>
          <Icon name="search" size={17} style={{ color: 'var(--text-muted)' }} />
          <input
            ref={inputRef}
            className={s.input}
            value={query}
            placeholder="Go to a page, switch project, run a command…"
            aria-label="Search commands"
            aria-activedescendant={results[cursor] ? `cmd-${results[cursor].id}` : undefined}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
          />
          <span className={s.hint}>esc</span>
        </div>

        <div className={s.list} ref={listRef} role="listbox" aria-label="Commands">
          {results.length === 0 ? (
            <div className={s.empty}>
              Nothing matches “{query}”.
              <br />
              Try a page name, a project, or “theme”.
            </div>
          ) : (
            results.map((c, i) => {
              const showGroup = c.group !== lastGroup;
              lastGroup = c.group;
              return (
                <div key={c.id} style={{ display: 'contents' }}>
                  {showGroup && <div className={s.group}>{c.group}</div>}
                  <button
                    type="button"
                    id={`cmd-${c.id}`}
                    role="option"
                    aria-selected={i === cursor}
                    data-active={i === cursor}
                    className={cx(s.item, i === cursor && s.itemActive)}
                    // Hover moves the cursor rather than drawing a second
                    // highlight, so there is only ever one selected row.
                    onMouseMove={() => setCursor(i)}
                    onClick={() => c.run()}
                  >
                    <Icon name={c.icon} size={15} className={s.itemIcon} />
                    <span className={s.itemText}>
                      <span className={s.itemLabel}>{c.label}</span>
                      {c.meta && <span className={s.itemMeta}>{c.meta}</span>}
                    </span>
                    {i === cursor && <span className={s.itemKey}>↵</span>}
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className={s.footer}>
          <span className={s.footKey}>
            <kbd>↑</kbd>
            <kbd>↓</kbd> navigate
          </span>
          <span className={s.footKey}>
            <kbd>↵</kbd> open
          </span>
          <span className={s.footKey} style={{ marginLeft: 'auto' }}>
            <kbd>⌘</kbd>
            <kbd>K</kbd> toggle
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
