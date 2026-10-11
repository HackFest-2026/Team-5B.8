import type { HTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { changeTone, percent } from '@/lib/format';
import { Icon, type IconName } from './Icon';
import s from './Card.module.css';

type Pad = 'none' | 'sm' | 'md';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  pad?: Pad;
  tone?: 'default' | 'accent' | 'critical';
  children: ReactNode;
}

// `string | undefined`, not `string`: a CSS module lookup is an index access,
// and `cx` is what drops the undefined cases.
const padClass: Record<Pad, string | undefined> = {
  none: s.flush,
  sm: s.paddedSm,
  md: s.padded,
};

export function Card({ pad = 'none', tone = 'default', className, children, ...rest }: CardProps) {
  return (
    <div
      className={[
        s.card,
        padClass[pad],
        tone === 'accent' ? s.accented : '',
        tone === 'critical' ? s.critical : '',
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {children}
    </div>
  );
}

/** A card that navigates. An anchor, so it behaves like one. */
export function LinkCard({
  to,
  pad = 'md',
  className,
  children,
}: {
  to: string;
  pad?: Pad;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      className={[s.card, padClass[pad], s.interactive, className ?? ''].filter(Boolean).join(' ')}
    >
      {children}
    </Link>
  );
}

export function CardHeader({
  title,
  subtitle,
  actions,
  bare,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Drops the divider, for a header sitting directly above its own padding. */
  bare?: boolean;
}) {
  return (
    <div className={[s.header, bare ? s.headerBare : ''].filter(Boolean).join(' ')}>
      <div className={s.titleGroup}>
        <div className={s.title}>{title}</div>
        {subtitle && <div className={s.subtitle}>{subtitle}</div>}
      </div>
      {actions && <div className={s.actions}>{actions}</div>}
    </div>
  );
}

export function CardBody({ tight, children }: { tight?: boolean; children: ReactNode }) {
  return <div className={tight ? s.bodyTight : s.body}>{children}</div>;
}

/** A heading for a run of content that is not itself inside a card. */
export function SectionHead({
  title,
  note,
  actions,
}: {
  title: ReactNode;
  note?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={s.sectionHead}>
      <div>
        <h2 className={s.sectionTitle}>{title}</h2>
        {note && <div className={s.sectionNote}>{note}</div>}
      </div>
      {actions && <div className={s.actions}>{actions}</div>}
    </div>
  );
}

export function MetricGrid({ children }: { children: ReactNode }) {
  return <div className={s.metricGrid}>{children}</div>;
}

export interface MetricProps {
  label: string;
  value: ReactNode;
  icon?: IconName;
  /** A percentage change, already in percentage units. */
  change?: number | null;
  /**
   * Whether an increase is good. Revenue: yes. Latency and fallbacks: no.
   * There is no sensible default, so it is required whenever `change` is given.
   */
  changeIsGood?: boolean;
  foot?: ReactNode;
}

export function Metric({ label, value, icon, change, changeIsGood = true, foot }: MetricProps) {
  const tone = changeTone(change);
  // Map direction to meaning: a 'down' latency figure is good news and must be
  // green, which is why the tone class is chosen here rather than by direction.
  const toneClass =
    tone === 'flat' ? s.flat : (tone === 'up') === changeIsGood ? s.up : s.down;

  return (
    <div className={s.metric}>
      <div className={s.metricLabel}>
        {icon && <Icon name={icon} size={13} />}
        {label}
      </div>
      <div className={s.metricValue}>{value}</div>
      <div className={s.metricFoot}>
        {change !== null && change !== undefined && tone !== 'flat' && (
          <span className={`${s.delta} ${toneClass}`}>
            <Icon name={tone === 'up' ? 'arrow-up' : 'arrow-down'} size={11} strokeWidth={2} />
            {percent(Math.abs(change))}
          </span>
        )}
        {foot}
      </div>
    </div>
  );
}
