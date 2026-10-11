import type { ReactNode } from 'react';
import type { Severity, StrategyMode } from '@/api/endpoints';
import { describeState, type ConnectionState } from '@/lib/ws';
import { Icon, type IconName } from './Icon';
import s from './Badge.module.css';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'critical' | 'info';

export function Badge({
  tone = 'neutral',
  caps,
  icon,
  children,
}: {
  tone?: Tone;
  /** Uppercase + tracked, for system states rather than prose. */
  caps?: boolean;
  icon?: IconName;
  children: ReactNode;
}) {
  return (
    <span className={[s.badge, s[tone], caps ? s.caps : ''].filter(Boolean).join(' ')}>
      {icon && <Icon name={icon} size={11} strokeWidth={2} />}
      {children}
    </span>
  );
}

/**
 * The strategy lifecycle state.
 *
 * The colour carries the meaning: only ACTIVE is accented, because only ACTIVE
 * is pricing real customers. SHADOW is informational — it is running, but no
 * customer sees its output — and PAUSED is a warning rather than an error,
 * since pausing is a legitimate operational choice.
 */
const MODE_TONE: Record<string, Tone> = {
  draft: 'neutral',
  validated: 'info',
  shadow: 'info',
  active: 'success',
  paused: 'warning',
};

export function ModeBadge({ mode }: { mode: StrategyMode | string | null | undefined }) {
  if (!mode) return <Badge caps>unknown</Badge>;
  return (
    <Badge tone={MODE_TONE[mode] ?? 'neutral'} caps>
      {mode}
    </Badge>
  );
}

const SEVERITY_TONE: Record<Severity, Tone> = {
  info: 'info',
  warning: 'warning',
  critical: 'critical',
};

const SEVERITY_ICON: Record<Severity, IconName> = {
  info: 'info',
  warning: 'warning',
  critical: 'critical',
};

export function SeverityBadge({ severity }: { severity: Severity | string }) {
  const key = (severity in SEVERITY_TONE ? severity : 'info') as Severity;
  return (
    <Badge tone={SEVERITY_TONE[key]} icon={SEVERITY_ICON[key]} caps>
      {severity}
    </Badge>
  );
}

/**
 * The live connection state.
 *
 * Human words, never a close code — the spec is explicit that technical
 * connection state gets translated before it reaches the screen.
 */
export function LiveIndicator({ state }: { state: ConnectionState }) {
  const dotClass =
    state === 'connected'
      ? s.dotConnected
      : state === 'offline'
        ? s.dotOffline
        : s.dotConnecting;

  return (
    <span className={s.live} role="status" aria-live="polite">
      <span className={`${s.dot} ${dotClass}`} aria-hidden="true" />
      {describeState(state)}
    </span>
  );
}

export interface Stage {
  id: string;
  label: string;
}

/**
 * The strategy lifecycle as a connected rail: DRAFT → VALIDATE → … → ACTIVE.
 *
 * Deliberately not a progress bar. A strategy can sit in SHADOW indefinitely by
 * design, and a bar implies it is on its way somewhere.
 */
export function PipelineRail({
  stages,
  currentId,
}: {
  stages: readonly Stage[];
  currentId: string | null;
}) {
  const currentIndex = stages.findIndex((st) => st.id === currentId);
  return (
    <div className={s.pipeline} role="list">
      {stages.map((st, i) => {
        const isCurrent = i === currentIndex;
        const isDone = currentIndex >= 0 && i < currentIndex;
        return (
          <span
            key={st.id}
            role="listitem"
            aria-current={isCurrent ? 'step' : undefined}
            className={[s.stage, isDone ? s.stageDone : '', isCurrent ? s.stageCurrent : '']
              .filter(Boolean)
              .join(' ')}
          >
            {isDone && <Icon name="check" size={11} strokeWidth={2.4} />}
            {st.label}
          </span>
        );
      })}
    </div>
  );
}

/** The lifecycle the backend actually implements, in promotion order. */
export const STRATEGY_STAGES: readonly Stage[] = [
  { id: 'draft', label: 'Draft' },
  { id: 'validated', label: 'Validated' },
  { id: 'shadow', label: 'Shadow' },
  { id: 'active', label: 'Active' },
];
