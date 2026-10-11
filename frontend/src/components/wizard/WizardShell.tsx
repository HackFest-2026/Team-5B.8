import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { cx } from '@/lib/cx';
import { StepVisual, type StepVisualKind } from './StepVisual';
import s from './WizardShell.module.css';

/**
 * The frame every wizard step renders inside.
 *
 * Holds the chrome — progress rail, draft state, navigation — so each step only
 * has to supply its own fields. That keeps the steps short enough to read, and
 * means the rail and the Continue-later behaviour cannot drift between them.
 */

export interface WizardStepMeta {
  id: string;
  /** Shown in the rail. Kept to one or two words. */
  label: string;
  visual: StepVisualKind;
  eyebrow: string;
  title: string;
  lead: string;
  /** The caption under the diagram: what the picture is telling you. */
  visualTitle: string;
  visualBody: string;
}

export interface WizardShellProps {
  steps: readonly WizardStepMeta[];
  currentIndex: number;
  children: ReactNode;

  onBack: () => void;
  onNext: () => void;
  onExit: () => void;
  /** Lets the user jump back to a step they have already completed. */
  onJump?: (index: number) => void;

  nextLabel?: string;
  nextDisabled?: boolean;
  busy?: boolean;
  /** Replaces the footer buttons entirely — used while tests are running. */
  footer?: ReactNode;
  /** Shown beside the footer buttons, e.g. a validation hint. */
  hint?: ReactNode;

  /** When the draft was last written, so the user can trust leaving. */
  savedAt?: number | null;
  saving?: boolean;
}

export function WizardShell({
  steps,
  currentIndex,
  children,
  onBack,
  onNext,
  onExit,
  onJump,
  nextLabel = 'Continue',
  nextDisabled,
  busy,
  footer,
  hint,
  savedAt,
  saving,
}: WizardShellProps) {
  const step = steps[currentIndex];
  if (!step) return null;

  return (
    <div className={s.root}>
      {/* ── top bar ───────────────────────────────────────────────────── */}
      <header className={s.bar}>
        <div className={s.barLeft}>
          {currentIndex > 0 && (
            <Button variant="ghost" size="sm" icon="chevron-left" onClick={onBack} disabled={busy}>
              Back
            </Button>
          )}
        </div>

        <nav className={s.rail} aria-label="Progress">
          {steps.map((st, i) => {
            const done = i < currentIndex;
            const current = i === currentIndex;
            return (
              <div key={st.id} style={{ display: 'contents' }}>
                {i > 0 && (
                  <span className={cx(s.railLine, i <= currentIndex && s.railLineDone)} />
                )}
                <button
                  type="button"
                  className={cx(s.railStep, done && s.railDone, current && s.railCurrent)}
                  aria-current={current ? 'step' : undefined}
                  // Only backwards. Jumping ahead would skip a decision the
                  // later steps are built from.
                  disabled={!done || !onJump}
                  onClick={() => done && onJump?.(i)}
                >
                  <span className={s.railDot}>
                    {done ? <Icon name="check" size={11} strokeWidth={3} /> : i + 1}
                  </span>
                  <span className={s.railLabel}>{st.label}</span>
                </button>
              </div>
            );
          })}
        </nav>

        <div className={s.barRight}>
          <span className={s.draftState}>
            {saving ? (
              <>
                <Icon name="spinner" size={11} />
                Saving
              </>
            ) : savedAt ? (
              <>
                <span className={s.savedDot} />
                Draft saved
              </>
            ) : null}
          </span>
          {/* The step controls live here, in the one top strip — no separate
              bottom bar. A custom `footer` (e.g. a running test) replaces them. */}
          {footer ?? (
            <>
              {hint && <span className={s.footHint}>{hint}</span>}
              <Button variant="ghost" size="sm" onClick={onExit} disabled={busy}>
                Continue later
              </Button>
              <Button
                variant="primary"
                iconAfter="arrow-right"
                loading={busy}
                disabled={nextDisabled}
                onClick={onNext}
              >
                {nextLabel}
              </Button>
            </>
          )}
        </div>
      </header>

      {/* ── body ──────────────────────────────────────────────────────── */}
      <div className={s.body}>
        {/* `key` restarts the enter animation on every step, so moving forward
            feels like travel rather than a swap. */}
        <div className={s.formCol} key={step.id}>
          <div className={s.eyebrow}>
            <Icon name="dot" size={9} strokeWidth={4} />
            {step.eyebrow}
          </div>
          <h1 className={s.title}>{step.title}</h1>
          <p className={s.lead}>{step.lead}</p>
          <div className={s.fields}>{children}</div>
        </div>

        <aside className={s.visualCol}>
          <div className={s.visualCard}>
            <StepVisual kind={step.visual} />
          </div>
          <div className={s.visualCaption}>
            <div className={s.visualTitle}>{step.visualTitle}</div>
            <p className={s.visualBody}>{step.visualBody}</p>
          </div>
        </aside>
      </div>

    </div>
  );
}

/**
 * The seven steps, with the copy that explains each one.
 *
 * Products sit at step 3, before rules: a rule written without the catalogue
 * on screen is written against imagined numbers.
 */
export const WIZARD_STEPS: readonly WizardStepMeta[] = [
  {
    id: 'project',
    label: 'Project',
    visual: 'project',
    eyebrow: 'Step 1',
    title: 'Name your pricing system',
    lead: 'One project is one pricing system. It can hold three products or three million, so you will almost never need a second one.',
    visualTitle: 'Your own workspace',
    visualBody:
      'Everything you set up here — items, rules, limits, API key — belongs to this project alone and is never mixed with another.',
  },
  {
    id: 'signals',
    label: 'Schema',
    visual: 'signals',
    eyebrow: 'Step 2',
    title: 'What information affects your price?',
    lead: 'Add the information your rules can use — and say where each piece lives: on the item, across the whole project, or supplied with each request.',
    visualTitle: 'Three kinds of input',
    visualBody:
      'Item values differ per product, overall conditions are shared by all, and request values arrive with each call — all feed the same engine.',
  },
  {
    id: 'catalogue',
    label: 'Products',
    visual: 'catalogue',
    eyebrow: 'Step 3',
    title: 'What are you selling?',
    lead: 'Add a few by hand, import a file, or start from sample data. Everything here can be changed later, and the more you add now the more your tests will cover.',
    visualTitle: 'Your pricing catalogue',
    visualBody:
      'DevNexus keeps only what pricing needs — your ID, a base price, and an optional cost. Your own system stays the source of truth.',
  },
  {
    id: 'pricing',
    label: 'Rules & limits',
    visual: 'guardrails',
    eyebrow: 'Step 4',
    title: 'Set the limits, then the rules inside them',
    lead: 'Start with the limits the price can never cross — then write the rules that move it within that band. Setting the limits first means the AI designs rules that fit, instead of ones the guardrails have to fight.',
    visualTitle: 'Limits protect, rules decide',
    visualBody:
      'However much the rules ask for, the price is held inside the band you set — and every decision records that it was.',
  },
  {
    id: 'live',
    label: 'Live',
    visual: 'live',
    eyebrow: 'Step 5',
    title: 'Your pricing API is live',
    lead: 'Two endpoints do the work: one returns a price, one tells the engine what is happening. Everything else is ordinary catalogue management.',
    visualTitle: 'One GET, a price back',
    visualBody:
      'Your checkout asks for a price and gets one in milliseconds, with an id you can use later to explain exactly why.',
  },
];
