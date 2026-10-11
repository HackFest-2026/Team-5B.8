import type { CSSProperties } from 'react';

import s from './StepVisual.module.css';

/**
 * One diagram per wizard step.
 *
 * Each of these exists to answer "what am I actually doing here?" without a
 * paragraph of explanation — signals converging on an engine says more about
 * step 2 than a sentence beginning "context signals are…".
 *
 * They are deliberately schematic rather than illustrative. The product is
 * pricing infrastructure, so the visual language is wires, plates and gauges,
 * not characters or abstract blobs.
 *
 * All inline SVG on one 240x240 viewBox, animated purely in CSS. They sit
 * beside a form the user is typing into, so they must never pull focus: slow
 * cycles, one idea each, no sound-and-fury.
 */

export type StepVisualKind =
  | 'project'
  | 'signals'
  | 'catalogue'
  | 'rules'
  | 'guardrails'
  | 'tests'
  | 'live';

export function StepVisual({ kind }: { kind: StepVisualKind }) {
  return (
    <div className={s.stage} aria-hidden="true">
      <svg className={s.svg} viewBox="0 0 240 240" fill="none">
        {kind === 'project' && <ProjectVisual />}
        {kind === 'signals' && <SignalsVisual />}
        {kind === 'catalogue' && <CatalogueVisual />}
        {kind === 'rules' && <RulesVisual />}
        {kind === 'guardrails' && <GuardrailsVisual />}
        {kind === 'tests' && <TestsVisual />}
        {kind === 'live' && <LiveVisual />}
      </svg>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   1. PROJECT — a workspace being provisioned
   ═══════════════════════════════════════════════════════════════════════ */

function ProjectVisual() {
  return (
    <>
      {/* the project plate, resolving into existence */}
      <g className={s.dropIn}>
        <rect x="68" y="42" width="104" height="44" rx="8" className={s.plateAccent} />
        <circle cx="84" cy="64" r="4" fill="var(--accent)" />
        <rect x="96" y="58" width="52" height="4" rx="2" fill="var(--accent-text)" opacity="0.8" />
        <rect x="96" y="68" width="32" height="3" rx="1.5" fill="var(--text-muted)" />
      </g>

      {/* the wire down to storage */}
      <path d="M120 86 L120 150" className={s.wire} strokeDasharray="3 4" />
      <circle cx="120" cy="92" r="3.5" className={s.packet} />

      {/* the store: three stacked platters */}
      <g>
        <ellipse cx="120" cy="156" rx="40" ry="11" className={s.plate} />
        <path d="M80 156 L80 176" className={s.wire} />
        <path d="M160 156 L160 176" className={s.wire} />
        <ellipse cx="120" cy="176" rx="40" ry="11" className={s.plate} />
        <path d="M80 176 L80 194" className={s.wire} />
        <path d="M160 176 L160 194" className={s.wire} />
        <ellipse cx="120" cy="194" rx="40" ry="11" className={s.plate} />
      </g>

      {/* the store acknowledging the write */}
      <g className={s.ack}>
        <circle cx="120" cy="156" r="14" className={s.coreRing} />
        <path d="M113 156 l5 5 l9 -10" stroke="var(--accent)" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </g>

      <text x="120" y="222" textAnchor="middle" className={s.label}>
        workspace provisioned
      </text>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   2. SIGNALS — four inputs converging on the engine
   ═══════════════════════════════════════════════════════════════════════ */

type Anchor = 'start' | 'middle' | 'end';

const STREAMS: { d: string; label: string; x: number; y: number; anchor?: Anchor }[] = [
  { d: 'M26 44 C70 54, 86 88, 104 112', label: 'demand', x: 20, y: 36 },
  { d: 'M214 44 C170 54, 154 88, 136 112', label: 'stock', x: 220, y: 36, anchor: 'end' },
  { d: 'M26 196 C70 186, 86 152, 104 128', label: 'traffic', x: 20, y: 212 },
  { d: 'M214 196 C170 186, 154 152, 136 128', label: 'rivals', x: 220, y: 212, anchor: 'end' },
];

function SignalsVisual() {
  return (
    <>
      {STREAMS.map((st, i) => (
        <g key={st.label}>
          <path d={st.d} className={s.wire} strokeDasharray="2 5" />
          {/* travels the exact path, so the motion reads as "feeding in" */}
          {/* `offset-path` drives the dot along the exact wire. Where it is
              unsupported the dot simply never appears, which leaves the wires
              and labels — still a correct diagram, just not an animated one. */}
          <circle
            r="3"
            className={s.streamDot}
            style={
              {
                offsetPath: `path("${st.d}")`,
                animationDelay: `${i * 0.28}s`,
              } as CSSProperties
            }
          />
          <text
            x={st.x}
            y={st.y}
            textAnchor={st.anchor ?? 'start'}
            className={s.label}
          >
            {st.label}
          </text>
        </g>
      ))}

      {/* the engine core they all feed */}
      <g className={s.core}>
        <circle cx="120" cy="120" r="30" className={s.coreRing} />
        <circle cx="120" cy="120" r="21" className={s.plateAccent} />
      </g>
      <circle cx="120" cy="120" r="5" fill="var(--accent)" />

      <text x="120" y="124" textAnchor="middle" className={s.labelBright}
            style={{ transform: 'translateY(28px)' }}>
        engine
      </text>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   3. CATALOGUE — rows arriving into a list
   ═══════════════════════════════════════════════════════════════════════ */

function CatalogueVisual() {
  const rows = [0, 1, 2, 3];
  return (
    <>
      <rect x="44" y="52" width="152" height="140" rx="10" className={s.plate} />
      {/* header bar, so it reads as a table not a stack of cards */}
      <rect x="44" y="52" width="152" height="24" rx="10" fill="var(--surface-sunken)" />
      <rect x="56" y="62" width="26" height="4" rx="2" fill="var(--text-muted)" />
      <rect x="104" y="62" width="34" height="4" rx="2" fill="var(--text-muted)" />
      <rect x="156" y="62" width="26" height="4" rx="2" fill="var(--text-muted)" />

      {rows.map((i) => (
        <g key={i} className={s.row} style={{ animationDelay: `${i * 0.22}s` }}>
          <rect x="56" y={88 + i * 24} width="22" height="5" rx="2.5" fill="var(--accent)" opacity="0.85" />
          <rect x="88" y={88 + i * 24} width="54" height="5" rx="2.5" fill="var(--text-secondary)" />
          <rect x="152" y={88 + i * 24} width="30" height="5" rx="2.5" fill="var(--text-muted)" />
        </g>
      ))}

      <text x="120" y="216" textAnchor="middle" className={s.label}>
        what you price
      </text>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   4. RULES — a threshold being crossed, opening a gate
   ═══════════════════════════════════════════════════════════════════════ */

function RulesVisual() {
  return (
    <>
      {/* the gauge: a value climbing toward a marked threshold */}
      <path d="M48 110 A 72 72 0 0 1 192 110" className={s.wire} strokeWidth="3" strokeLinecap="round" />
      <path d="M48 110 A 72 72 0 0 1 192 110" className={s.gauge} />

      {/* the threshold mark the rule tests against */}
      <path d="M150 54 L156 44" stroke="var(--critical)" strokeWidth="1.6" strokeLinecap="round" />
      <text x="162" y="42" className={s.label} fill="var(--critical-text)">
        80
      </text>

      <text x="120" y="98" textAnchor="middle" className={s.labelBright}>
        demand
      </text>

      {/* the gate: shut until the threshold trips, then lifts */}
      <g className={s.gateOpen}>
        <rect x="86" y="140" width="68" height="14" rx="4" className={s.plateAccent} />
      </g>
      <path d="M86 162 L154 162" className={s.wire} />

      {/* the adjustment that results */}
      <g>
        <rect x="92" y="176" width="56" height="22" rx="6" className={s.plate} />
        <text x="120" y="191" textAnchor="middle" className={s.labelBright}>
          +5%
        </text>
      </g>

      <text x="120" y="222" textAnchor="middle" className={s.label}>
        when … then …
      </text>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   5. GUARDRAILS — a price rising into a ceiling and being held
   ═══════════════════════════════════════════════════════════════════════ */

function GuardrailsVisual() {
  return (
    <>
      {/* the permitted band */}
      <rect x="40" y="84" width="160" height="78" rx="6"
            fill="var(--success-muted)" opacity="0.35" />

      {/* ceiling and floor */}
      <path d="M40 84 L200 84" className={s.ceiling} />
      <path d="M40 162 L200 162" stroke="var(--success)" strokeWidth="1.2"
            strokeDasharray="5 4" opacity="0.5" />

      <text x="204" y="80" className={s.label} fill="var(--critical-text)">max</text>
      <text x="204" y="172" className={s.label} fill="var(--success-text)">min</text>

      {/* the price: climbs, then runs flat along the ceiling it cannot pass */}
      <path
        d="M44 150 C72 146, 86 128, 104 108 C112 98, 118 88, 124 84 L196 84"
        className={s.priceLine}
      />

      {/* where it was stopped */}
      <g className={s.blocked}>
        <circle cx="128" cy="84" r="5" />
        <path d="M124 72 L132 72" stroke="var(--critical)" strokeWidth="1.6" strokeLinecap="round" />
      </g>

      <text x="120" y="208" textAnchor="middle" className={s.label}>
        rules decide · guardrails protect
      </text>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   6. TESTS — checks resolving one after another
   ═══════════════════════════════════════════════════════════════════════ */

function TestsVisual() {
  const rows = [0, 1, 2];
  return (
    <>
      {rows.map((i) => (
        <g key={i} className={s.testRow} style={{ animationDelay: `${i * 0.5}s` }}>
          <rect x="40" y={72 + i * 40} width="160" height="30" rx="8" className={s.plate} />
          <circle cx="60" cy={87 + i * 40} r="9"
                  fill="var(--success-muted)" stroke="var(--success)" strokeWidth="1" />
          <path
            d={`M55 ${87 + i * 40} l4 4 l7 -8`}
            className={s.check}
            style={{ animationDelay: `${i * 0.5}s` }}
          />
          <rect x="78" y={81 + i * 40} width="62" height="4" rx="2" fill="var(--text-secondary)" />
          <rect x="78" y={90 + i * 40} width="38" height="3" rx="1.5" fill="var(--text-muted)" />
          <rect x="166" y={85 + i * 40} width="18" height="4" rx="2" fill="var(--success)" opacity="0.7" />
        </g>
      ))}

      <text x="120" y="214" textAnchor="middle" className={s.label}>
        proving it works
      </text>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   7. LIVE — the API answering callers
   ═══════════════════════════════════════════════════════════════════════ */

function LiveVisual() {
  return (
    <>
      {/* outward pulses: the API serving */}
      {[0, 1, 2].map((i) => (
        <circle
          key={i}
          cx="120"
          cy="120"
          r="56"
          className={s.pulseOut}
          style={{ animationDelay: `${i * 0.85}s` }}
        />
      ))}

      {/* the engine at the centre */}
      <circle cx="120" cy="120" r="26" className={s.plateAccent} />
      <circle cx="120" cy="120" r="5" fill="var(--accent)" />

      {/* the callers around it */}
      {[
        { x: 120, y: 34, label: 'web' },
        { x: 202, y: 120, label: 'app' },
        { x: 120, y: 206, label: 'pos' },
        { x: 38, y: 120, label: 'api' },
      ].map((c, i) => (
        <g key={c.label} className={s.client} style={{ animationDelay: `${i * 0.2}s` }}>
          <rect x={c.x - 20} y={c.y - 11} width="40" height="22" rx="6" className={s.plate} />
          <text x={c.x} y={c.y + 3} textAnchor="middle" className={s.label}>
            {c.label}
          </text>
        </g>
      ))}

      <text x="120" y="232" textAnchor="middle" className={s.labelBright}>
        one GET → a price
      </text>
    </>
  );
}
