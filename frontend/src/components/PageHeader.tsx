import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './ui/Icon';
import s from './PageHeader.module.css';

/**
 * The top of every page.
 *
 * `description` is not decoration — it answers "what am I configuring?" for a
 * business analyst who has not used the screen before, which the spec lists as
 * one of the questions the user must always be able to answer.
 */
export function PageHeader({
  title,
  description,
  actions,
  badge,
  breadcrumb,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** A status chip beside the title, e.g. the strategy mode. */
  badge?: ReactNode;
  breadcrumb?: { label: string; to?: string }[];
}) {
  return (
    <div className={s.header}>
      <div className={s.titleBlock}>
        {breadcrumb && breadcrumb.length > 0 && (
          <nav className={s.breadcrumb} aria-label="Breadcrumb">
            {breadcrumb.map((c, i) => (
              <span key={`${c.label}-${i}`} style={{ display: 'contents' }}>
                {i > 0 && <Icon name="chevron-right" size={11} />}
                {c.to ? (
                  <Link to={c.to} className={s.crumbLink}>
                    {c.label}
                  </Link>
                ) : (
                  <span>{c.label}</span>
                )}
              </span>
            ))}
          </nav>
        )}
        <h1 className={s.title}>
          {title}
          {badge}
        </h1>
        {description && <p className={s.description}>{description}</p>}
      </div>
      {actions && <div className={s.actions}>{actions}</div>}
    </div>
  );
}

/* ── layout primitives shared by the pages ───────────────────────────── */

export function Stack({ children, tight }: { children: ReactNode; tight?: boolean }) {
  return <div className={tight ? s.stackTight : s.stack}>{children}</div>;
}

export function TwoCol({ children }: { children: ReactNode }) {
  return <div className={s.twoCol}>{children}</div>;
}

/** Main content plus a narrower detail column. */
export function MainWithSide({ children }: { children: ReactNode }) {
  return <div className={s.sidebarRight}>{children}</div>;
}

export function Row({ children }: { children: ReactNode }) {
  return <div className={s.row}>{children}</div>;
}

export function Spread({ children }: { children: ReactNode }) {
  return <div className={s.spread}>{children}</div>;
}

export function Well({ children }: { children: ReactNode }) {
  return <div className={s.well}>{children}</div>;
}

export function Note({ children }: { children: ReactNode }) {
  return <p className={s.note}>{children}</p>;
}

export function Muted({ children }: { children: ReactNode }) {
  return <span className={s.muted}>{children}</span>;
}

/** A label/value list. Used on every detail panel in the app. */
export function KeyValues({
  rows,
}: {
  rows: readonly { key: string; value: ReactNode }[];
}) {
  return (
    <dl className={s.kv}>
      {rows.map((r) => (
        <div className={s.kvRow} key={r.key}>
          <dt className={s.kvKey}>{r.key}</dt>
          <dd className={s.kvValue}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}
