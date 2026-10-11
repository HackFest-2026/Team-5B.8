import React from 'react';
import { motion } from 'framer-motion';
import { Head } from '../ui.jsx';

/* Equal-sized KPI boxes, each with one line. Aligned to what the brief scores
   (§11 explainability + §14 reliability & control), with latency included. */
const KPIS = [
  { g: '🔁', t: 'Deterministic', m: 'Same inputs → the same price, every time (100% reproducible).' },
  { g: '💡', t: 'Explainable', m: 'Every price returns the exact drivers behind it.' },
  { g: '🧾', t: 'Auditable', m: 'Who changed what, and when — a full trail.' },
  { g: '⚔️', t: 'Conflict-checked', m: 'Clashing rules are flagged before they go live.' },
  { g: '↩️', t: 'Versioned + rollback', m: 'Change safely, revert to any version in one click.' },
  { g: '✅', t: 'Human approval', m: 'Big pricing changes are gated by a person.' },
  { g: '🛟', t: 'Never fails', m: 'Safe fallback — a price always comes back.' },
  { g: '⚡', t: 'Fast', m: '~4 ms per price (p50); p99 alarmed under 150 ms.' },
];

export default function KPIs() {
  return (
    <div>
      <Head no="12" eyebrow="Reliability & control — what pricing really needs"
        title={<>Key performance <span className="hl">indicators.</span></>} sm
        right={<span className="pill dot">measured on the running system</span>} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 16, alignItems: 'stretch' }}>
        {KPIS.map((k, n) => (
          <motion.div key={k.t} className="card col"
            style={{ padding: 'clamp(16px,1.5vw,22px)', gap: 8, borderTop: '3px solid var(--accent)', justifyContent: 'flex-start' }}
            initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + n * 0.07, duration: 0.45, ease: [0.22, 0.61, 0.36, 1] }}>
            <div className="row center gap-s">
              <span style={{ fontSize: 22 }}>{k.g}</span>
              <b style={{ fontFamily: 'var(--display)', fontWeight: 800, fontSize: 'clamp(15px,1.25vw,19px)', letterSpacing: '-.015em' }}>{k.t}</b>
            </div>
            <span className="muted" style={{ fontSize: 'clamp(12.5px,1vw,14px)', lineHeight: 1.45 }}>{k.m}</span>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
