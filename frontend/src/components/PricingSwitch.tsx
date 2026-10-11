import { useState } from 'react';
import { strategiesApi } from '@/api/endpoints';
import { ConfirmDialog } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useMutation } from '@/hooks/useAsync';
import { useSession } from '@/hooks/useSession';
import { cx } from '@/lib/cx';
import { Icon } from './ui/Icon';
import s from './PricingSwitch.module.css';

/**
 * Dynamic pricing: on or off.
 *
 * This replaces the whole visible lifecycle. Draft, validated, shadow, promote
 * and rollback still exist in the backend — they are how the wizard gets a
 * strategy live — but none of them is a decision an operator makes day to day.
 * The one they do make is this.
 *
 * Turning it OFF genuinely stops the pricing API: callers get a refusal rather
 * than a base price dressed up as a quote. Everything else — catalogue edits,
 * events, analytics — keeps working, so the switch means exactly what it says.
 */
export function PricingSwitch({
  compact,
  /** Bar form: a short label, a smaller throw, and no card around it. */
  inline,
}: {
  compact?: boolean;
  inline?: boolean;
}) {
  const { project, refresh } = useSession();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);

  const on = project?.mode === 'active';

  const flip = useMutation(
    async (next: boolean) => {
      if (!project?.active_strategy_id) {
        throw new Error('This project has no strategy to switch on yet.');
      }
      return strategiesApi.promote(
        project.project_id,
        project.active_strategy_id,
        next ? 'active' : 'paused',
      );
    },
    {
      onSuccess: async () => {
        setConfirming(false);
        await refresh();
      },
      onError: (e) => toast.error('Could not change that', e.message),
    },
  );

  if (!project) return null;

  const turnOn = async () => {
    const res = await flip.run(true);
    if (res?.pending_approval) {
      toast.info(
        'Waiting for approval',
        'This project requires approval to publish. Approve it on the dashboard to go live.',
      );
      return;
    }
    toast.success('Dynamic pricing is on', 'Your rules apply from the next request.');
  };

  const turnOff = async () => {
    await flip.run(false);
    toast.info('Dynamic pricing is off', 'The pricing API will stop returning prices.');
  };

  return (
    <>
      <div className={cx(s.wrap, on && s.wrapOn, compact && s.compact, inline && s.inline)}>
        <div className={s.text}>
          {inline ? (
            // One line in the bar. The full sentence is still on the project's
            // settings screen, where there is room to explain what OFF means.
            <div className={s.inlineLabel}>{on ? 'Pricing on' : 'Pricing off'}</div>
          ) : (
            <>
              <div className={s.label}>Dynamic pricing</div>
              <div className={s.state}>
                {on ? 'Live — rules are applying' : 'Off — the pricing API is not serving'}
              </div>
            </>
          )}
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Dynamic pricing"
          disabled={flip.pending}
          className={cx(s.track, on && s.trackOn)}
          // Turning it ON is safe and instant. Turning it OFF stops real
          // customers getting prices, so that direction is confirmed.
          onClick={() => (on ? setConfirming(true) : void turnOn())}
        >
          <span className={cx(s.knob, on && s.knobOn)}>
            {flip.pending && <Icon name="spinner" size={10} />}
          </span>
        </button>
      </div>

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={turnOff}
        title="Turn dynamic pricing off?"
        body={
          <>
            Your rules stop applying and the pricing API stops returning prices for{' '}
            <strong>{project.name}</strong>.
          </>
        }
        consequence="Anything calling the pricing API will get a refusal, not a price. If your checkout depends on it, make sure it can fall back before you do this."
        details={[
          { label: 'Project', value: project.name },
          { label: 'Still works', value: 'Catalogue, events, analytics' },
          { label: 'Stops', value: 'Price requests' },
        ]}
        confirmLabel="Turn it off"
        pending={flip.pending}
        error={flip.error}
      />
    </>
  );
}
