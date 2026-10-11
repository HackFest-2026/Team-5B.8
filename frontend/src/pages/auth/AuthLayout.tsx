import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Logo } from '@/components/Logo';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useTheme } from '@/hooks/useTheme';
import { cx } from '@/lib/cx';
import s from './Auth.module.css';

/**
 * The shared frame for sign-in, sign-up and onboarding.
 *
 * The right-hand panel is restated product value, not decoration — and it is
 * the first thing to go at tablet width, because on a narrow screen the form is
 * the only thing that matters.
 */

export interface AuthLayoutProps {
  heading: string;
  sub?: ReactNode;
  children: ReactNode;
  /** Shown under the form: the link to the other auth screen. */
  alt?: ReactNode;
  wide?: boolean;
  steps?: { label: string; state: 'done' | 'active' | 'todo' }[];
  asideTitle?: string;
  asideBody?: string;
  asidePoints?: string[];
}

const DEFAULT_POINTS = [
  'Configure a pricing domain without writing code',
  'Backtest a strategy against your own history',
  'Shadow it against live traffic before activating',
  'Explain and replay any price you have ever served',
];

export function AuthLayout({
  heading,
  sub,
  children,
  alt,
  wide,
  steps,
  asideTitle = 'From pricing strategy to live decision.',
  asideBody = 'DevNexus is one engine for every domain. Your schema defines what it understands; your rules decide what it does; your guardrails decide how far it may go.',
  asidePoints = DEFAULT_POINTS,
}: AuthLayoutProps) {
  const { theme, toggle } = useTheme();

  return (
    <div className={s.page}>
      <div className={s.formSide}>
        <div className={s.topBar}>
          <Link to="/" aria-label="DevNexus home">
            <Logo />
          </Link>
          <Button
            variant="ghost"
            size="sm"
            icon={theme === 'dark' ? 'sun' : 'moon'}
            onClick={toggle}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          />
        </div>

        <div className={s.formWrap}>
          <div className={cx(s.form, wide && s.wideForm)}>
            {steps && (
              <div className={s.steps}>
                {steps.map((step, i) => (
                  <div key={step.label} style={{ display: 'contents' }}>
                    {i > 0 && <span className={s.stepLine} aria-hidden="true" />}
                    <span
                      className={cx(
                        s.step,
                        step.state === 'active' && s.stepActive,
                        step.state === 'done' && s.stepDone,
                      )}
                      aria-current={step.state === 'active' ? 'step' : undefined}
                    >
                      <span className={s.stepDot}>
                        {step.state === 'done' ? (
                          <Icon name="check" size={10} strokeWidth={3} />
                        ) : (
                          i + 1
                        )}
                      </span>
                      {step.label}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <h1 className={s.heading}>{heading}</h1>
            {sub && <p className={s.sub}>{sub}</p>}

            {children}

            {alt && <div className={s.alt}>{alt}</div>}
          </div>
        </div>
      </div>

      <aside className={s.aside}>
        <div className={s.asideGrid} aria-hidden="true" />
        <div className={s.asideInner}>
          <div className={s.asideQuote}>{asideTitle}</div>
          <p className={s.asideBody}>{asideBody}</p>
          <div className={s.asideList}>
            {asidePoints.map((p) => (
              <div key={p} className={s.asideItem}>
                <Icon name="check" size={14} strokeWidth={2.4} className={s.asideCheck} />
                {p}
              </div>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}
