import type { ReactNode } from 'react';
import type { DevNexusError } from '@/api/client';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';
import s from './Feedback.module.css';

/* ===========================================================================
   Skeletons — never a blank screen
   =========================================================================== */

export function SkeletonLine({ width = '100%', height }: { width?: string; height?: number }) {
  return (
    <div
      className={`skeleton ${s.line}`}
      style={{ width, ...(height ? { height } : {}) }}
      aria-hidden="true"
    />
  );
}

export function SkeletonBlock({ height = 120 }: { height?: number }) {
  return <div className={`skeleton ${s.block}`} style={{ height }} aria-hidden="true" />;
}

/**
 * A run of skeleton lines with varied widths.
 *
 * Varied, because equal-length bars look like a loading graphic; uneven ones
 * read as text that has not arrived yet, which is what is actually happening.
 */
export function SkeletonText({ lines = 3 }: { lines?: number }) {
  const widths = ['92%', '78%', '85%', '64%', '88%'];
  return (
    <div className={s.stack} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <SkeletonLine key={i} width={widths[i % widths.length]} />
      ))}
    </div>
  );
}

/* ===========================================================================
   Empty states
   =========================================================================== */

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  /** What to do next. Required: an empty state without a next step is a dead end. */
  body: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}

export function EmptyState({ icon, title, body, action, compact }: EmptyStateProps) {
  return (
    <div className={[s.empty, compact ? s.emptyCompact : ''].filter(Boolean).join(' ')}>
      {icon && (
        <div className={s.emptyIcon}>
          <Icon name={icon} size={20} />
        </div>
      )}
      <div className={s.emptyTitle}>{title}</div>
      <div className={s.emptyBody}>{body}</div>
      {action && <div className={s.emptyActions}>{action}</div>}
    </div>
  );
}

/* ===========================================================================
   Errors
   =========================================================================== */

/**
 * A failed request.
 *
 * The server's own message is shown, because the backend writes them for people
 * ("that does not look like a valid email address"), not for logs. The machine
 * code sits underneath in small type for the cases where someone needs to quote
 * it. A retry appears whenever the caller can retry.
 */
export function ErrorState({
  error,
  title = 'Could not load this',
  onRetry,
  compact,
}: {
  error: DevNexusError | Error | null;
  title?: string;
  onRetry?: () => void;
  /**
   * Scoped to one section rather than the whole page.
   *
   * Use this whenever the rest of the page still works. A dashboard draws from
   * a dozen independent endpoints, and a full-width alert for one of them makes
   * a working page look offline — which is exactly what happened when a single
   * analytics call failed while the project, strategy, decisions and health all
   * loaded fine.
   */
  compact?: boolean;
}) {
  if (!error) return null;
  const code = 'code' in error ? (error as DevNexusError).code : null;
  const status = 'status' in error ? (error as DevNexusError).status : null;

  // A dropped connection retries itself (see useAsync), so say so rather than
  // presenting a dead end with a button the user has to find and press.
  const selfHealing = code === 'network' || code === 'timeout';

  if (compact) {
    return (
      <div className={s.errorCompact} role="status">
        <Icon name={selfHealing ? 'spinner' : 'warning'} size={14} className={s.errorIcon} />
        <span className={s.errorCompactText}>
          {title}
          {selfHealing && <span className={s.errorCompactCode}>reconnecting…</span>}
          {!selfHealing && code && <span className={s.errorCompactCode}>{code}</span>}
          {/* A timeout means the route is being dropped, not that the server is
              busy — the API answers in well under a second when reachable. Say
              the likely cause instead of spinning silently forever. */}
          {code === 'timeout' && (
            <span className={s.errorCompactHint}>
              No response at all. If you are on a VPN or proxy, try turning it off.
            </span>
          )}
        </span>
        {onRetry && (
          <button type="button" className={s.errorCompactRetry} onClick={onRetry}>
            {selfHealing ? 'Retry now' : 'Retry'}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={s.error} role="alert">
      <Icon name="warning" size={18} className={s.errorIcon} />
      <div className={s.errorBody}>
        <div className={s.errorTitle}>{title}</div>
        <div className={s.errorMessage}>{error.message}</div>
        {code && (
          <div className={s.errorCode}>
            {code}
            {status ? ` · ${status}` : ''}
          </div>
        )}
        {onRetry && (
          <div className={s.errorActions}>
            <Button size="sm" icon="refresh" onClick={onRetry}>
              Try again
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ===========================================================================
   Progress
   =========================================================================== */

/**
 * An in-progress async operation, with its own wording.
 *
 * The label is required: "Running historical simulation…" tells the user what
 * is happening and roughly how long to expect, and a bare spinner does not.
 */
export function Loading({ label, inline }: { label: string; inline?: boolean }) {
  return (
    <div className={inline ? s.inline : s.centred} role="status" aria-live="polite">
      <Icon name="spinner" size={inline ? 14 : 18} />
      {label}
    </div>
  );
}

/** A determinate bar, for uploads and jobs that report real percentages. */
export function Progress({ value, label }: { value: number; label?: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div>
      {label && (
        <div className={s.inline} style={{ marginBottom: 'var(--s-2)' }}>
          {label}
        </div>
      )}
      <div
        className={s.progressTrack}
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ?? 'Progress'}
      >
        <div className={s.progressFill} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
