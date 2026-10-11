import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '@/components/ui/Icon';
import { cx } from '@/lib/cx';
import s from './SetupChecklist.module.css';

/**
 * Progress through getting a project live.
 *
 * A new project lands on a dashboard with nothing in it, and the lifecycle is
 * long enough (items → rules → strategy → validate → test → activate) that it is
 * genuinely unclear what to do next. This card answers that, and disappears once
 * the project is active so it never nags an established user.
 *
 * Every step is derived from REAL state the dashboard already has — no separate
 * requests, and no local "has the user visited this page" flag, which would tick
 * off a step the user merely looked at.
 */

export interface SetupState {
  hasItems: boolean;
  hasRules: boolean;
  hasStrategy: boolean;
  isValidated: boolean;
  hasTested: boolean;
  isLive: boolean;
}

interface Step {
  id: string;
  label: string;
  why: string;
  done: boolean;
  to: string;
}

const DISMISS_KEY = 'devnexus.checklist.dismissed';

export function SetupChecklist({ state, projectId }: { state: SetupState; projectId: string }) {
  const navigate = useNavigate();
  // Dismissal is per project: finishing setup on one should not hide the guide
  // for a brand new one.
  const [dismissed, setDismissed] = useState(() => {
    try {
      return (localStorage.getItem(DISMISS_KEY) ?? '').split(',').includes(projectId);
    } catch {
      return false;
    }
  });

  const steps: Step[] = [
    {
      id: 'items',
      label: 'Add what you price',
      why: 'Every price starts from an item’s base price',
      done: state.hasItems,
      to: '/app/items',
    },
    {
      id: 'rules',
      label: 'Write a pricing rule',
      why: 'One business decision — when to move the price, and by how much',
      done: state.hasRules,
      to: '/app/rules',
    },
    {
      id: 'strategy',
      label: 'Build a strategy',
      why: 'Bundles your rules into something you can promote as a unit',
      done: state.hasStrategy,
      to: '/app/strategies',
    },
    {
      id: 'validate',
      label: 'Validate it',
      why: 'Checks conflicts and guardrail coverage before anything goes live',
      done: state.isValidated,
      to: '/app/strategies',
    },
    {
      id: 'test',
      label: 'Test it',
      why: 'What-if or backtest, so you see the effect before a customer does',
      done: state.hasTested,
      to: '/app/simulation',
    },
    {
      id: 'activate',
      label: 'Activate and connect your API',
      why: 'Start serving real prices',
      done: state.isLive,
      to: '/app/api',
    },
  ];

  const doneCount = steps.filter((st) => st.done).length;

  // Gone once the project is live, or once dismissed. A finished checklist is
  // clutter, not reassurance.
  if (state.isLive || dismissed) return null;

  // The first incomplete step is the one highlighted — never two.
  const nextIndex = steps.findIndex((st) => !st.done);

  const dismiss = () => {
    setDismissed(true);
    try {
      const prev = (localStorage.getItem(DISMISS_KEY) ?? '').split(',').filter(Boolean);
      localStorage.setItem(DISMISS_KEY, [...new Set([...prev, projectId])].join(','));
    } catch {
      /* dismissal applies for this session only */
    }
  };

  return (
    <div className={s.card}>
      <div className={s.head}>
        <Icon name="sparkle" size={18} style={{ color: 'var(--accent)', flexShrink: 0 }} />
        <div className={s.headText}>
          <div className={s.title}>Finish setting up this project</div>
          <div className={s.sub}>
            {doneCount === 0
              ? 'Six steps from here to a live pricing API.'
              : `${steps.length - doneCount} ${
                  steps.length - doneCount === 1 ? 'step' : 'steps'
                } left before you can go live.`}
          </div>
        </div>
        <div className={s.progress}>
          <span className={s.count}>
            {doneCount} / {steps.length}
          </span>
          <div
            className={s.track}
            role="progressbar"
            aria-valuenow={doneCount}
            aria-valuemin={0}
            aria-valuemax={steps.length}
            aria-label="Setup progress"
          >
            <div className={s.fill} style={{ width: `${(doneCount / steps.length) * 100}%` }} />
          </div>
        </div>
      </div>

      <div className={s.steps}>
        {steps.map((st, i) => (
          <button key={st.id} type="button" className={s.step} onClick={() => navigate(st.to)}>
            <span
              className={cx(s.mark, st.done && s.markDone, i === nextIndex && s.markNext)}
            >
              {st.done ? <Icon name="check" size={11} strokeWidth={3} /> : i + 1}
            </span>
            <span className={cx(s.label, st.done && s.labelDone)}>
              {st.label}
              {!st.done && <span className={s.why}>{st.why}</span>}
            </span>
            {!st.done && <Icon name="arrow-right" size={14} className={s.go} />}
          </button>
        ))}
      </div>

      <button type="button" className={s.dismiss} onClick={dismiss}>
        Hide this
      </button>
    </div>
  );
}
