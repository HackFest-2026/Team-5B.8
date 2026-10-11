import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Logo } from '@/components/Logo';
import { Button, LinkButton } from '@/components/ui/Button';
import { CodeBlock } from '@/components/ui/Code';
import { Icon, type IconName } from '@/components/ui/Icon';
import { useReveal } from '@/hooks/useReveal';
import { useTheme } from '@/hooks/useTheme';
import { cx } from '@/lib/cx';
import s from './Landing.module.css';

/**
 * The landing page.
 *
 * It sells the product, not the infrastructure — there is no mention of Lambda,
 * DynamoDB or SQS anywhere on this page, by design.
 *
 * On the numbers: the hotel scenario (₹5,000 → ₹5,400 on high occupancy) is a
 * worked example, labelled as one, used to explain what the engine does. It is
 * not dashboard data dressed up as real. Everything inside the application
 * proper comes from the API.
 */

/* ── a section that fades in as it scrolls into view ───────────────────── */
function Reveal({
  children,
  className,
  delayMs = 0,
}: {
  children: ReactNode;
  className?: string;
  delayMs?: number;
}) {
  const { ref, revealed } = useReveal<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className={cx(s.reveal, revealed && s.revealed, className)}
      style={delayMs ? { transitionDelay: `${delayMs}ms` } : undefined}
    >
      {children}
    </div>
  );
}

function SectionHeader({
  eyebrow,
  title,
  lead,
}: {
  eyebrow?: string;
  title: string;
  lead?: ReactNode;
}) {
  return (
    <Reveal className={s.sectionHeader}>
      {eyebrow && <div className={s.eyebrow}>{eyebrow}</div>}
      <h2 className={s.h2}>{title}</h2>
      {lead && <p className={s.lead}>{lead}</p>}
    </Reveal>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   HERO VISUAL — business context flows to a price
   ═══════════════════════════════════════════════════════════════════════ */

const PIPELINE = [
  { icon: 'live' as IconName, label: 'Business context', detail: 'Events and signals arriving', value: 'occupancy 88%' },
  { icon: 'rules' as IconName, label: 'Pricing strategy', detail: 'Rules, priority, conflicts', value: 'v3 · 4 rules' },
  { icon: 'decisions' as IconName, label: 'Decision', detail: 'Deterministic evaluation', value: 'DEC-CC90CF' },
  { icon: 'shield' as IconName, label: 'Guardrails', detail: 'Safety limits applied', value: 'max +10%' },
];

function HeroVisual() {
  // One stage lights at a time, on a slow loop. Slow on purpose: the point is
  // to read as a system working through a sequence, not to attract attention.
  const [stage, setStage] = useState(0);

  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      // Rest on the final stage so the result is visible without any motion.
      setStage(PIPELINE.length - 1);
      return;
    }
    const timer = window.setInterval(
      () => setStage((v) => (v + 1) % (PIPELINE.length + 1)),
      1500,
    );
    return () => clearInterval(timer);
  }, []);

  return (
    <Reveal className={s.pipelineViz}>
      <div className={s.vizHead}>
        <span>Pricing pipeline</span>
        <span>Live</span>
      </div>

      {PIPELINE.map((p, i) => (
        <div key={p.label}>
          <div className={cx(s.vizStage, stage === i && s.vizStageActive)}>
            <span className={s.vizIcon}>
              <Icon name={p.icon} size={15} />
            </span>
            <span className={s.vizLabel}>
              {p.label}
              <span className={s.vizDetail} style={{ display: 'block' }}>
                {p.detail}
              </span>
            </span>
            <span className={s.vizValue}>{p.value}</span>
          </div>
          {i < PIPELINE.length - 1 && <div className={s.vizConnector} />}
        </div>
      ))}

      <div className={s.vizResult}>
        <span className={s.vizResultLabel}>Price</span>
        <span className={s.vizResultValue}>₹5,400</span>
      </div>
    </Reveal>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   ONE ENGINE, EVERY DOMAIN
   ═══════════════════════════════════════════════════════════════════════ */

const DOMAINS = [
  { name: 'Hospitality', signal: 'occupancy, availability' },
  { name: 'E-commerce', signal: 'demand, inventory' },
  { name: 'Transportation', signal: 'demand, driver_supply' },
  { name: 'Travel', signal: 'seats_left, days_out' },
  { name: 'EV charging', signal: 'grid_load, queue_length' },
  { name: 'Co-working', signal: 'desk_occupancy, walk_in_rate' },
];

function DomainSection() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;
    const timer = window.setInterval(() => setActive((v) => (v + 1) % DOMAINS.length), 1800);
    return () => clearInterval(timer);
  }, []);

  const current = DOMAINS[active] ?? DOMAINS[0]!;

  return (
    <section className={cx(s.section, s.banded)} id="platform">
      <SectionHeader
        eyebrow="One engine. Every domain."
        title="New domains are configuration, not code changes."
        lead={
          <>
            The engine has no idea what a hotel room, a product or a ride is. It evaluates the
            signals your schema declares. Adding an industry means describing it — never changing
            the pricing logic.
          </>
        }
      />

      <Reveal className={s.domainLayout}>
        <div className={s.domainList}>
          {DOMAINS.map((d, i) => (
            <div key={d.name} className={cx(s.domainChip, i === active && s.domainChipActive)}>
              <span>{d.name}</span>
              <span className={s.domainSignal}>{d.signal}</span>
            </div>
          ))}
        </div>

        <div className={s.engineCore}>
          <Icon name="simulation" size={24} style={{ color: 'var(--accent)' }} />
          <div className={s.engineTitle}>DevNexus engine</div>
          <div className={s.engineNote}>
            Deterministic. Schema-driven. No domain logic inside.
          </div>
          <div className={s.engineBadge}>evaluate()</div>
        </div>

        <div className={s.domainOut}>
          <div className={s.priceOut}>
            <div className={s.priceOutLabel}>{current.name} price</div>
            <div className={s.priceOutValue}>
              {active === 0
                ? '₹5,400'
                : active === 1
                  ? '₹1,249'
                  : active === 2
                    ? '₹286'
                    : active === 3
                      ? '₹7,980'
                      : active === 4
                        ? '₹18.40'
                        : '₹640'}
            </div>
            <div className={s.priceOutWhy}>
              Driven by <span className="mono">{current.signal}</span>
            </div>
          </div>
          <div className={s.priceOut}>
            <div className={s.priceOutLabel}>Same engine</div>
            <div className={s.priceOutWhy} style={{ marginTop: 'var(--s-2)' }}>
              The ruleset, the schema and the guardrails change per project. The evaluation does
              not.
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   FROM BUSINESS DATA TO PRICE
   ═══════════════════════════════════════════════════════════════════════ */

const INPUTS = [
  {
    title: 'Historical data',
    body: 'Understand past behaviour and test strategies before they touch a customer.',
  },
  { title: 'Real-time events', body: 'React to what is happening now, within milliseconds.' },
  { title: 'Business rules', body: 'Encode the decisions your team already makes by hand.' },
  { title: 'Strategy', body: 'A versioned set of rules you can promote, pause and roll back.' },
  { title: 'Guardrails', body: 'Never let pricing move beyond boundaries you set.' },
];

function InputsSection() {
  return (
    <section className={cx(s.section, s.divided)}>
      <SectionHeader
        eyebrow="From business data to price"
        title="Five inputs. One deterministic decision."
        lead="Every price DevNexus returns is a function of these, and nothing else. No hidden model, no drift between runs."
      />
      <div className={s.flowGrid}>
        {INPUTS.map((f, i) => (
          <Reveal key={f.title} delayMs={i * 60}>
            <div className={s.flowCard}>
              <span className={s.flowIndex}>{String(i + 1).padStart(2, '0')}</span>
              <div className={s.flowTitle}>{f.title}</div>
              <div className={s.flowBody}>{f.body}</div>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   TEST BEFORE YOU LAUNCH
   ═══════════════════════════════════════════════════════════════════════ */

const LIFECYCLE = [
  { name: 'Draft', desc: 'Build the ruleset. Nothing is live.' },
  { name: 'Validate', desc: 'Conflicts, gaps and guardrail coverage are checked.' },
  { name: 'What-if', desc: 'Price one item under conditions you invent.' },
  { name: 'Backtest', desc: 'Replay it over your own historical window.' },
  { name: 'Shadow', desc: 'Run against live traffic. No customer sees the output.' },
  { name: 'Active', desc: 'Serving real prices, with rollback one click away.' },
];

function LifecycleSection() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setStep(LIFECYCLE.length - 1);
      return;
    }
    const timer = window.setInterval(() => setStep((v) => (v + 1) % LIFECYCLE.length), 1600);
    return () => clearInterval(timer);
  }, []);

  return (
    <section className={cx(s.section, s.banded)} id="lifecycle">
      <SectionHeader
        eyebrow="Test before you launch"
        title="A pricing strategy has a lifecycle, not a deploy button."
        lead="Nothing reaches a customer until it has been validated, simulated and — if you want — run silently alongside what is already live."
      />

      <Reveal>
        <div className={s.lifecycle}>
          {LIFECYCLE.map((l, i) => (
            <div key={l.name} className={cx(s.lifecycleStep, i === step && s.lifecycleStepActive)}>
              <div className={s.lifecycleName}>{l.name}</div>
              <div className={s.lifecycleDesc}>{l.desc}</div>
            </div>
          ))}
        </div>
      </Reveal>

      <Reveal>
        <div className={s.whatifGrid}>
          <div className={s.compareCol}>
            <div className={s.compareLabel}>Current price</div>
            <div className={s.comparePrice}>₹5,000</div>
            <div className={s.compareRows}>
              <div className={s.compareRow}>
                <span className={s.compareKey}>Occupancy</span>
                <span className={s.compareVal}>64%</span>
              </div>
              <div className={s.compareRow}>
                <span className={s.compareKey}>Availability</span>
                <span className={s.compareVal}>36%</span>
              </div>
              <div className={s.compareRow}>
                <span className={s.compareKey}>Rules fired</span>
                <span className={s.compareVal}>None</span>
              </div>
            </div>
          </div>

          <div className={cx(s.compareCol, s.compareColHighlight)}>
            <div className={s.compareLabel}>Simulated — what if</div>
            <div className={s.comparePrice}>₹5,400</div>
            <div className={s.compareRows}>
              <div className={s.compareRow}>
                <span className={s.compareKey}>Occupancy</span>
                <span className={s.compareVal}>95%</span>
              </div>
              <div className={s.compareRow}>
                <span className={s.compareKey}>Availability</span>
                <span className={s.compareVal}>5%</span>
              </div>
              <div className={s.compareRow}>
                <span className={s.compareKey}>Rule fired</span>
                <span className={s.compareVal}>High demand · +8%</span>
              </div>
              <div className={s.compareRow}>
                <span className={s.compareKey}>Guardrail</span>
                <span className={cx(s.compareVal, s.driverUp)}>Passed</span>
              </div>
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   GUARDRAILS
   ═══════════════════════════════════════════════════════════════════════ */

function GuardrailSection() {
  // The marker walks past the ceiling and gets clamped back. This is the
  // section's whole argument, so the motion is the content rather than decoration.
  const [exceeding, setExceeding] = useState(false);

  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setExceeding(true);
      return;
    }
    const timer = window.setInterval(() => setExceeding((v) => !v), 2600);
    return () => clearInterval(timer);
  }, []);

  // 4,000 … 7,000 mapped onto a 0-100% track with headroom on each side.
  const MIN = 3400;
  const MAX = 7600;
  const pos = (v: number) => ((v - MIN) / (MAX - MIN)) * 100;

  const wanted = exceeding ? 8200 : 5400;
  const final = Math.min(wanted, 7000);

  return (
    <section className={cx(s.section, s.divided)} id="safety">
      <SectionHeader
        eyebrow="Safety"
        title="Rules decide. Guardrails protect."
        lead="A rule can ask for anything. Guardrails are applied afterwards, so a mistake in a rule cannot become a mistake on a customer's bill."
      />

      <div className={s.guardWrap}>
        <Reveal>
          <div className={s.guardTrack}>
            <div
              className={s.guardBand}
              style={{ left: `${pos(4000)}%`, width: `${pos(7000) - pos(4000)}%` }}
            >
              <span className={s.guardBandLabel} style={{ left: 0 }}>
                min ₹4,000
              </span>
              <span className={s.guardBandLabel} style={{ left: '100%' }}>
                max ₹7,000
              </span>
            </div>

            {wanted > 7000 && (
              <div className={s.guardMarkerWanted} style={{ left: `${pos(wanted)}%` }}>
                <span
                  className={s.guardMarkerCap}
                  style={{ color: 'var(--critical-text)' }}
                >
                  rules wanted ₹{wanted.toLocaleString('en-IN')}
                </span>
              </div>
            )}

            <div className={s.guardMarkerFinal} style={{ left: `${pos(final)}%` }}>
              <span className={s.guardMarkerCap} style={{ color: 'var(--accent-text)' }}>
                charged ₹{final.toLocaleString('en-IN')}
              </span>
            </div>
          </div>

          <p className={s.lead} style={{ marginTop: 'var(--s-7)' }}>
            {wanted > 7000
              ? 'The ruleset asked for ₹8,200. The maximum price guardrail clamped it to ₹7,000, and the decision records that it did.'
              : 'Inside the permitted band, the price the rules produced is the price charged.'}
          </p>
        </Reveal>

        <Reveal className={s.guardList} delayMs={80}>
          {[
            ['Minimum price', '₹4,000'],
            ['Maximum price', '₹7,000'],
            ['Maximum increase', '+10%'],
            ['Maximum decrease', '−15%'],
            ['Minimum margin', '12%'],
          ].map(([k, v]) => (
            <div key={k} className={s.guardRow}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
                <Icon name="shield" size={14} style={{ color: 'var(--success-text)' }} />
                {k}
              </span>
              <span className={s.guardVal}>{v}</span>
            </div>
          ))}
        </Reveal>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   EXPLAINABILITY
   ═══════════════════════════════════════════════════════════════════════ */

function ExplainSection() {
  return (
    <section className={cx(s.section, s.banded)} id="explain">
      <SectionHeader
        eyebrow="Explainability"
        title="Every price has a reason."
        lead="Not an AI summary of a price — the actual rules that fired, in the order they were applied, with the signal values they were evaluated against."
      />

      <Reveal className={s.explainCard}>
        <div>
          <div className={s.explainPrice}>₹5,400</div>
          <div className={s.explainMeta}>
            <span>Decision · DEC-CC90CFFCA2</span>
            <span>Strategy · Dynamic Demand v3</span>
            <span>Evaluated · 10:42:11</span>
          </div>
        </div>

        <div>
          <div className={s.driverList}>
            <div className={s.driverRow}>
              <span>
                High occupancy and low availability
                <span className={s.vizDetail} style={{ display: 'block' }}>
                  occupancy 88% · availability 8%
                </span>
              </span>
              <span className={cx(s.driverImpact, s.driverUp)}>+8.0%</span>
            </div>
            <div className={s.driverRow}>
              <span>
                Weekend premium
                <span className={s.vizDetail} style={{ display: 'block' }}>
                  day_of_week SAT
                </span>
              </span>
              <span className={cx(s.driverImpact, s.driverUp)}>+0.0%</span>
            </div>
            <div className={s.driverRow}>
              <span>
                Competitor undercut
                <span className={s.vizDetail} style={{ display: 'block' }}>
                  suppressed — lower priority in conflict group “demand”
                </span>
              </span>
              <span className={s.driverImpact} style={{ color: 'var(--text-muted)' }}>
                skipped
              </span>
            </div>
          </div>

          <div className={s.verifyStrip}>
            <div className={s.verifyItem}>
              <span className={s.verifyLabel}>Original</span>
              <span className={s.verifyValue}>₹5,400.00</span>
            </div>
            <div className={s.verifyItem}>
              <span className={s.verifyLabel}>Recomputed</span>
              <span className={s.verifyValue}>₹5,400.00</span>
            </div>
            <div className={s.verifyItem}>
              <span className={s.verifyLabel}>Difference</span>
              <span className={s.verifyValue}>₹0.00</span>
            </div>
            <div className={s.verifyItem}>
              <span className={s.verifyLabel}>Deterministic</span>
              <span className={cx(s.verifyValue, s.driverUp)}>Verified</span>
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   REAL-TIME
   ═══════════════════════════════════════════════════════════════════════ */

const TIMELINE = [
  { time: '10:42:08', text: 'Booking received · Room R204', value: '+1' },
  { time: '10:42:09', text: 'Occupancy 82% → 88%', value: '+6pt' },
  { time: '10:42:10', text: 'Demand signal recalculated', value: '0.74' },
  { time: '10:42:11', text: 'Rule “High demand” triggered', value: '+8%' },
  { time: '10:42:11', text: 'Price ₹5,000 → ₹5,400', value: '4.1ms' },
];

const SIGNALS = [
  { name: 'Occupancy', value: 88, unit: '%', fill: 88 },
  { name: 'Availability', value: 8, unit: '%', fill: 8 },
  { name: 'Demand', value: 0.74, unit: '', fill: 74 },
  { name: 'Competitor gap', value: -4.2, unit: '%', fill: 42 },
];

function RealtimeSection() {
  // Rows appear one at a time so the sequence reads as cause and effect rather
  // than as a static list of five log lines.
  const [visible, setVisible] = useState(TIMELINE.length);

  useEffect(() => {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;
    setVisible(0);
    let n = 0;
    const timer = window.setInterval(() => {
      n = n >= TIMELINE.length ? 0 : n + 1;
      setVisible(n);
    }, 900);
    return () => clearInterval(timer);
  }, []);

  return (
    <section className={cx(s.section, s.divided)} id="live">
      <SectionHeader
        eyebrow="Real-time"
        title="Watch a booking become a price."
        lead="Events stream in, context updates, the strategy evaluates, and the new price appears — on the same dashboard your team is already watching."
      />

      <div className={s.liveLayout}>
        <Reveal className={s.timeline}>
          <div className={s.timelineHead}>
            <span className={s.timelineTitle}>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 999,
                  background: 'var(--success)',
                  animation: 'pulse-dot 2s ease-in-out infinite',
                }}
              />
              Live activity
            </span>
            <span className={s.timelineTime}>Room R204</span>
          </div>
          <div className={s.timelineRows}>
            {TIMELINE.slice(0, visible).map((t, i) => (
              <div className={s.timelineRow} key={`${t.time}-${i}`}>
                <span className={s.timelineTime}>{t.time}</span>
                <span className={s.timelineText}>{t.text}</span>
                <span
                  className={s.timelineValue}
                  style={i === TIMELINE.length - 1 ? { color: 'var(--accent-text)' } : undefined}
                >
                  {t.value}
                </span>
              </div>
            ))}
          </div>
        </Reveal>

        <Reveal className={s.signalGrid} delayMs={80}>
          {SIGNALS.map((sig) => (
            <div key={sig.name} className={s.signalCard}>
              <div className={s.signalName}>{sig.name}</div>
              <div className={s.signalValue}>
                {sig.value}
                {sig.unit}
              </div>
              <div className={s.signalBar}>
                <div className={s.signalFill} style={{ width: `${sig.fill}%` }} />
              </div>
            </div>
          ))}
        </Reveal>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   INTEGRATION
   ═══════════════════════════════════════════════════════════════════════ */

const PRICE_CALL = `GET /v1/p/{project_key}/price?item_id=R204`;

const PRICE_RESPONSE = `{
  "ok": true,
  "price": {
    "item_id": "R204",
    "price": 5400,
    "currency": "INR",
    "decision_id": "DEC-CC90CFFCA2",
    "changed": true,
    "drivers": [
      { "factor": "High demand", "impact": "+8%" }
    ]
  }
}`;

const EVENT_CALL = `GET /v1/t/{project_key}/event
  ?item_id=R204
  &event_type=booking
  &event_id=bk_8f21c4`;

function IntegrationSection() {
  return (
    <section className={cx(s.section, s.banded)} id="integrate">
      <SectionHeader
        eyebrow="Go live"
        title="One API call to get the price."
        lead={
          <>
            No SDK to adopt and no request bodies to build. Ask for a price, send an event — both
            are a single GET your application can make from anywhere.
          </>
        }
      />

      <div className={s.integrateGrid}>
        <Reveal>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
            <CodeBlock code={PRICE_CALL} title="Ask for a price" />
            <CodeBlock code={PRICE_RESPONSE} title="Response" />
          </div>
        </Reveal>
        <Reveal delayMs={80}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>
            <CodeBlock code={EVENT_CALL} title="Report what happened" />
            <div className={s.flowCard}>
              <div className={s.flowTitle}>Your application stays in control</div>
              <div className={s.flowBody}>
                DevNexus never talks to your customers. It answers with a price and a decision id;
                what you do with them is yours. Every price carries the decision id, so you can
                explain it later without storing anything yourself.
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   CONTROL
   ═══════════════════════════════════════════════════════════════════════ */

function ControlSection() {
  return (
    <section className={cx(s.section, s.divided)} id="control">
      <SectionHeader
        eyebrow="Control"
        title="Decisions reach a person before they become incidents."
        lead="When something looks wrong, DevNexus does not silently keep pricing. It raises the question, recommends an action, and waits for an answer — on the dashboard or as a push notification."
      />

      <Reveal>
        <div className={s.incident}>
          <div className={s.incidentHead}>
            <Icon name="critical" size={18} style={{ color: 'var(--critical-text)' }} />
            <div>
              <div className={s.incidentTitle}>Demand anomaly detected</div>
              <div className={s.vizDetail}>Room R204 · 2 minutes ago</div>
            </div>
          </div>

          <div className={s.incidentBody}>
            Prices rose 9.4% in under ten minutes, driven almost entirely by one rule. That is
            inside your guardrails, but it is unusual for this item at this hour.
          </div>

          <div className={s.incidentFacts}>
            <div className={s.incidentFact}>
              <span className={s.compareKey}>Current strategy</span>
              <span className={s.compareVal}>Dynamic Demand v3</span>
            </div>
            <div className={s.incidentFact}>
              <span className={s.compareKey}>Previous version</span>
              <span className={s.compareVal}>v2 — stable for 6 days</span>
            </div>
            <div className={s.incidentFact}>
              <span className={s.compareKey}>Affected items</span>
              <span className={s.compareVal}>1 of 48</span>
            </div>
          </div>

          <div className={s.incidentQuestion}>What should DevNexus do?</div>
          <div className={s.incidentOptions}>
            <button type="button" className={cx(s.incidentOption, s.incidentOptionDanger)}>
              <span>Roll back to v2</span>
              <span className={s.recommended}>recommended</span>
            </button>
            <button type="button" className={s.incidentOption}>
              <span>Pause the strategy</span>
              <Icon name="pause" size={14} />
            </button>
            <button type="button" className={s.incidentOption}>
              <span>Keep monitoring</span>
              <Icon name="clock" size={14} />
            </button>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   CAPABILITIES
   ═══════════════════════════════════════════════════════════════════════ */

const CAPABILITIES: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'simulation',
    title: 'One engine across domains',
    body: 'No hardcoded industry logic. Your schema defines what the engine understands.',
  },
  {
    icon: 'rules',
    title: 'Configuration-driven',
    body: 'Rules, strategies and guardrails are data. Changing pricing does not mean a release.',
  },
  {
    icon: 'live',
    title: 'Real-time context',
    body: 'Events update signals continuously, with time decay so stale demand stops counting.',
  },
  {
    icon: 'decisions',
    title: 'Deterministic decisions',
    body: 'Same inputs, same price, every time — and we can prove it on any past decision.',
  },
  {
    icon: 'analytics',
    title: 'Backtest before launch',
    body: 'Replay a strategy across your own history and see what it would have earned.',
  },
  {
    icon: 'strategies',
    title: 'Shadow without impact',
    body: 'Run a candidate against live traffic while customers keep seeing the current price.',
  },
  {
    icon: 'shield',
    title: 'Guardrails',
    body: 'Floors, ceilings, movement caps and margin protection, applied after every rule.',
  },
  {
    icon: 'rollback',
    title: 'Instant rollback',
    body: 'One action returns live pricing to a previous version. No redeploy, no waiting.',
  },
  {
    icon: 'api',
    title: 'Low-latency API',
    body: 'A single GET returns a price in a few milliseconds, with a safe fallback if anything is degraded.',
  },
];

function CapabilitiesSection() {
  return (
    <section className={cx(s.section, s.banded)}>
      <SectionHeader eyebrow="Why DevNexus" title="What the platform actually does." />
      <Reveal>
        <div className={s.capGrid}>
          {CAPABILITIES.map((c) => (
            <div key={c.title} className={s.capCell}>
              <div className={s.capTitle}>
                <Icon name={c.icon} size={15} style={{ color: 'var(--accent)' }} />
                {c.title}
              </div>
              <div className={s.capBody}>{c.body}</div>
            </div>
          ))}
        </div>
      </Reveal>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   PAGE
   ═══════════════════════════════════════════════════════════════════════ */

export function LandingPage() {
  const { theme, toggle } = useTheme();

  return (
    <div className={s.page}>
      <header className={s.nav}>
        <Link to="/" aria-label="DevNexus home">
          <Logo />
        </Link>

        <nav className={s.navLinks} aria-label="Sections">
          <a className={s.navLink} href="#platform">
            Platform
          </a>
          <a className={s.navLink} href="#lifecycle">
            Lifecycle
          </a>
          <a className={s.navLink} href="#safety">
            Safety
          </a>
          <a className={s.navLink} href="#live">
            Real-time
          </a>
          <a className={s.navLink} href="#integrate">
            API
          </a>
        </nav>

        <div className={s.navActions}>
          <Button
            variant="ghost"
            size="sm"
            icon={theme === 'dark' ? 'sun' : 'moon'}
            onClick={toggle}
            aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          />
          <LinkButton to="/login" variant="ghost" size="sm">
            Sign in
          </LinkButton>
          <LinkButton to="/signup" variant="primary" size="sm">
            Get started
          </LinkButton>
        </div>
      </header>

      {/* ── hero ──────────────────────────────────────────────────────── */}
      <section className={s.hero}>
        <div className={s.gridBackdrop} aria-hidden="true" />

        <div className={s.heroCopy}>
          <div className={s.heroBadge}>
            <Icon name="dot" size={10} strokeWidth={4} style={{ color: 'var(--accent)' }} />
            Universal Dynamic Pricing Platform
          </div>

          <h1 className={s.h1}>Dynamic pricing, built to operate.</h1>

          <p className={s.heroSub}>
            Configure pricing strategies, test them safely, launch them through an API, and watch
            every decision happen in real time.
          </p>

          <div className={s.heroActions}>
            <LinkButton to="/signup" variant="primary" size="lg" iconAfter="arrow-right">
              Get started
            </LinkButton>
            <LinkButton to="/login" variant="secondary" size="lg">
              Explore the platform
            </LinkButton>
          </div>

          <div className={s.heroMeta}>
            <div className={s.heroMetaItem}>
              <span className={s.heroMetaValue}>Any domain</span>
              <span className={s.heroMetaLabel}>Schema-defined, not hardcoded</span>
            </div>
            <div className={s.heroMetaItem}>
              <span className={s.heroMetaValue}>Deterministic</span>
              <span className={s.heroMetaLabel}>Every decision replayable</span>
            </div>
            <div className={s.heroMetaItem}>
              <span className={s.heroMetaValue}>One GET</span>
              <span className={s.heroMetaLabel}>To price, and to report an event</span>
            </div>
          </div>
        </div>

        <HeroVisual />
      </section>

      <DomainSection />
      <InputsSection />
      <LifecycleSection />
      <GuardrailSection />
      <ExplainSection />
      <RealtimeSection />
      <IntegrationSection />
      <ControlSection />
      <CapabilitiesSection />

      {/* ── closing ───────────────────────────────────────────────────── */}
      <section className={cx(s.cta, s.divided)}>
        <Reveal>
          <h2 className={s.ctaHeadline}>
            From pricing strategy to live decision — one platform.
          </h2>
          <p className={s.ctaSub}>
            Configure, test, deploy and operate. Create a workspace and have your first pricing API
            running against your own data.
          </p>
          <div className={s.ctaActions}>
            <LinkButton to="/signup" variant="primary" size="lg" iconAfter="arrow-right">
              Create your workspace
            </LinkButton>
            <LinkButton to="/login" variant="ghost" size="lg">
              Sign in
            </LinkButton>
          </div>
        </Reveal>
      </section>

      <footer className={s.footer}>
        <div className={s.footerInner}>
          <Logo size={20} />
          <span>Universal Dynamic Pricing Platform</span>
        </div>
      </footer>
    </div>
  );
}
