import React from 'react';
import { motion } from 'framer-motion';
import { Reveal, Stagger } from '../ui.jsx';

const FLOW = [
  { n: 'Configure', s: 'Signals, products, rules and limits — visually or in plain English.' },
  { n: 'Simulate', s: 'Try any price before it ships, on the real engine.' },
  { n: 'Publish', s: 'One switch — versioned, approvable, roll-back-able.' },
  { n: 'Operate', s: 'Watch prices live, get alerted, approve from your phone.' },
];

/* A designed, animated console mock — not a screenshot. */
function ConsoleMock() {
  const bars = [52, 74, 44, 92, 66, 58, 82];
  return (
    <div className="browser">
      <div className="bar"><i /><i /><i /><span className="url">app.devnexus — dashboard</span><span className="badge-live" style={{ marginLeft: 'auto', fontSize: 11 }}>live</span></div>
      <div style={{ padding: 18, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, background: 'var(--paper)' }}>
        {[['Decisions', '1,284'], ['Avg price', '₹6,040'], ['Guardrail blocks', '37']].map(([k, v], i) => (
          <motion.div key={k} className="card" style={{ padding: '12px 14px' }}
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 + i * 0.12 }}>
            <div className="mono" style={{ fontSize: 10, color: 'var(--ink-4)' }}>{k}</div>
            <div className="statnum" style={{ fontSize: 24 }}>{v}</div>
          </motion.div>
        ))}
        <div className="card" style={{ gridColumn: '1 / 3', padding: 14 }}>
          <div className="mono" style={{ fontSize: 10, color: 'var(--ink-4)', marginBottom: 10 }}>price · last 7 days</div>
          <div className="row" style={{ alignItems: 'flex-end', gap: 8, height: 70 }}>
            {bars.map((h, i) => (
              <motion.div key={i} style={{ flex: 1, background: i === 3 ? 'var(--accent)' : 'var(--line-2)', borderRadius: 4 }}
                initial={{ height: 0 }} animate={{ height: `${h}%` }} transition={{ delay: 0.7 + i * 0.07, duration: 0.5 }} />
            ))}
          </div>
        </div>
        <motion.div className="card" style={{ padding: 14 }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1 }}>
          <div className="mono" style={{ fontSize: 10, color: 'var(--ink-4)', marginBottom: 8 }}>active rule</div>
          <div style={{ fontSize: 12, lineHeight: 1.5 }}><b>IF</b> demand = high <b>THEN</b> <span style={{ color: 'var(--accent-ink)' }}>+20%</span></div>
          <div style={{ marginTop: 8, height: 7, borderRadius: 5, background: 'var(--good-soft)', position: 'relative' }}>
            <motion.div style={{ position: 'absolute', inset: 0, background: 'var(--good)', borderRadius: 5, transformOrigin: 'left' }}
              initial={{ scaleX: 0 }} animate={{ scaleX: 0.7 }} transition={{ delay: 1.2, duration: 0.6 }} />
          </div>
        </motion.div>
      </div>
    </div>
  );
}

export default function Product() {
  return (
    <div className="col" style={{ gap: 'clamp(16px,1.8vw,26px)' }}>
      <Reveal><div className="eyebrow plain"><span className="no">04</span> Introducing</div></Reveal>

      <div className="row" style={{ gap: 'clamp(26px,3.4vw,56px)', alignItems: 'center' }}>
        {/* left: wordmark + flow */}
        <div className="col grow" style={{ flexBasis: '44%', gap: 'clamp(14px,1.6vw,22px)' }}>
          <motion.h1 className="display" style={{ fontSize: 'clamp(44px,6.6vw,104px)', lineHeight: .88 }}
            initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease: [0.22, 0.61, 0.36, 1] }}>
            Dev<span className="hl">Nexus</span>
          </motion.h1>
          <Reveal delay={0.25}>
            <p className="lead" style={{ fontSize: 'clamp(15px,1.3vw,20px)' }}>
              Dynamic pricing a <b>business team can run itself</b> — the whole lifecycle in one place.
            </p>
          </Reveal>
          <Stagger delay={0.4} gap={0.09} className="col" style={{ gap: 11, marginTop: 4 }}>
            {FLOW.map((f, n) => (
              <div key={f.n} className="row gap-m center">
                <span className="mono" style={{ fontSize: 13, color: 'var(--accent-ink)', fontWeight: 700, width: 16 }}>{n + 1}</span>
                <b style={{ fontSize: 'clamp(15px,1.25vw,19px)', width: 108, flex: 'none' }}>{f.n}</b>
                <span className="muted" style={{ fontSize: 'clamp(12.5px,1vw,14px)', lineHeight: 1.4 }}>{f.s}</span>
              </div>
            ))}
          </Stagger>
        </div>

        {/* right: animated console */}
        <Reveal delay={0.45} className="grow" style={{ flexBasis: '54%' }}><ConsoleMock /></Reveal>
      </div>
    </div>
  );
}
