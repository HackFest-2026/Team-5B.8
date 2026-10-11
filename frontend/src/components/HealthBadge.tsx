import { Badge, type Tone } from '@/components/ui/Badge';
import type { IconName } from '@/components/ui/Icon';
import type { HealthVerdict } from '@/lib/health';

/**
 * The pricing health badge, defined once.
 *
 * It lives here because four screens show it and they must never disagree —
 * and because the `waiting` verdict is easy to get wrong. A project that has
 * had no signals yet is NOT healthy (nothing has been proven) and NOT degraded
 * (nothing is broken). Falling through to "Healthy" would be exactly the kind
 * of hardcoded success this product refuses to show.
 */
const LOOK: Record<HealthVerdict, { label: string; tone: Tone; icon: IconName }> = {
  critical: { label: 'Not pricing', tone: 'critical', icon: 'warning' },
  warning: { label: 'Partial signals', tone: 'warning', icon: 'warning' },
  waiting: { label: 'Waiting for signals', tone: 'info', icon: 'clock' },
  healthy: { label: 'Healthy', tone: 'success', icon: 'check' },
};

export function HealthBadge({ verdict }: { verdict: HealthVerdict }) {
  const look = LOOK[verdict];
  return (
    <Badge tone={look.tone} icon={look.icon}>
      {look.label}
    </Badge>
  );
}

/** The same wording as plain text, for metric tiles that cannot take a badge. */
export function healthLabel(verdict: HealthVerdict): string {
  return LOOK[verdict].label;
}
