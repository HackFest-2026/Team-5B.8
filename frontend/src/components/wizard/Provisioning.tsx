import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '@/components/ui/Icon';
import { cx } from '@/lib/cx';
import s from './Provisioning.module.css';

/**
 * The moment the project becomes an API.
 *
 * Everything listed here has ALREADY happened — the key was minted when the
 * project row was created, the ruleset was published and activated when the
 * user left the limits step. This is a readout of that work, not a progress bar
 * pretending to do it, which is why no line can fail: there is nothing left in
 * flight to fail.
 *
 * It is paced rather than instant on purpose. The provisioning is genuinely
 * fast, and a screen that flashes past leaves the user with no idea what they
 * now own. A beat per line is the difference between "it said something" and
 * "I saw my API get built".
 */

interface Stage {
  icon: IconName;
  label: string;
  detail: string;
}

const STAGES: Stage[] = [
  { icon: 'shield', label: 'API key issued', detail: 'scoped to this project alone' },
  { icon: 'rules', label: 'Rules published to the engine', detail: 'compiled and version-stamped' },
  { icon: 'api', label: 'Pricing endpoint opened', detail: 'ready to answer in milliseconds' },
  { icon: 'live', label: 'Event stream connected', detail: 'so your signals can reach the engine' },
];

/** Paced so the whole sequence lands around 2.4s — deliberate, not slow. */
const STEP_MS = 520;
const SETTLE_MS = 420;

export function Provisioning({ onDone }: { onDone: () => void }) {
  const [done, setDone] = useState(-1);

  // Fired once. In StrictMode the effect runs twice, and without this the
  // timers would interleave and the lines would tick over at double speed.
  const ranRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    let cancelled = false;

    const run = async () => {
      for (let i = 0; i < STAGES.length; i += 1) {
        await new Promise((r) => setTimeout(r, STEP_MS));
        if (cancelled) return;
        setDone(i);
      }
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      if (!cancelled) onDoneRef.current();
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className={s.wrap}>
      <div className={s.orb} aria-hidden="true">
        <span className={s.orbRing} />
        <span className={s.orbRing} />
        <span className={s.orbCore}>
          <Icon name="api" size={22} />
        </span>
      </div>

      <div className={s.head}>
        <div className={s.title}>Building your pricing API</div>
        <p className={s.lead}>
          Your configuration is becoming a live endpoint. Nothing here is a template — it is
          generated from what you just described.
        </p>
      </div>

      <ul className={s.list}>
        {STAGES.map((st, i) => {
          const state = i <= done ? 'done' : i === done + 1 ? 'active' : 'waiting';
          return (
            <li
              key={st.label}
              className={cx(s.row, state === 'done' && s.rowDone, state === 'active' && s.rowActive)}
            >
              <span className={s.mark}>
                {state === 'done' ? (
                  <Icon name="check" size={13} strokeWidth={3} />
                ) : state === 'active' ? (
                  <Icon name="spinner" size={13} />
                ) : (
                  <Icon name={st.icon} size={13} />
                )}
              </span>
              <span className={s.text}>
                <span className={s.label}>{st.label}</span>
                <span className={s.detail}>{st.detail}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
