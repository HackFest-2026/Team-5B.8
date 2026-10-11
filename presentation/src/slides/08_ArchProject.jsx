import React from 'react';
import { motion } from 'framer-motion';
import { Head } from '../ui.jsx';

/* Architecture 3 — project creation flow. Unique visual: a horizontal timeline. */
const STATIONS = [
  { g: '👤', t: 'Sign up',        s: 'Account + workspace created.' },
  { g: '🗂️', t: 'Create project', s: 'One project = one pricing system.' },
  { g: '🧩', t: 'Design schema',  s: 'Declare item · overall · request signals.' },
  { g: '📦', t: 'Add products',   s: 'By hand, file import, or sample data.' },
  { g: '⚖️', t: 'Rules & limits', s: 'Write rules; set the guardrails around them.' },
  { g: '🔑', t: 'API key → live', s: 'Endpoints switch on. No per-project servers.' },
];

export default function ArchProject({ step }) {
  const done = (i) => step >= i;
  const pct = (step / (STATIONS.length - 1)) * 100;

  return (
    <div className="col" style={{ gap: 10 }}>
      <Head no="11" eyebrow="How a business goes live"
        title={<>From signup to a <span className="hl">live pricing API.</span></>} sm
        right={<span className="pill">{step + 1}/{STATIONS.length}</span>} />

      <div style={{ position: 'relative', height: 'min(58vh, 460px)', padding: '0 4%' }}>
        {/* track */}
        <div style={{ position: 'absolute', left: '4%', right: '22%', top: '50%', height: 3, background: 'var(--line-2)', borderRadius: 3 }} />
        <motion.div style={{ position: 'absolute', left: '4%', top: '50%', height: 3, background: 'var(--accent)', borderRadius: 3, transformOrigin: 'left' }}
          animate={{ width: `calc(74% * ${pct / 100})` }} transition={{ duration: 0.5, ease: [0.22, 0.61, 0.36, 1] }} />

        {STATIONS.map((st, i) => {
          const x = 4 + (i * 74) / (STATIONS.length - 1);
          const above = i % 2 === 0;
          return (
            <div key={i} style={{ position: 'absolute', left: `${x}%`, top: '50%', transform: 'translate(-50%,-50%)' }}>
              {/* dot */}
              <motion.div
                animate={{ scale: done(i) ? 1 : 0.85, backgroundColor: done(i) ? 'var(--accent)' : '#fff', color: done(i) ? '#fff' : 'var(--ink-4)', borderColor: done(i) ? 'var(--accent)' : 'var(--line-2)' }}
                transition={{ duration: 0.4 }}
                style={{ width: 44, height: 44, borderRadius: '50%', border: '2px solid', display: 'grid', placeItems: 'center', boxShadow: done(i) ? 'var(--shadow-m)' : 'var(--shadow-s)', position: 'relative', zIndex: 2, fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 15 }}>
                {done(i) ? (i === step ? st.g : '✓') : i + 1}
              </motion.div>
              {/* card */}
              <motion.div
                animate={{ opacity: done(i) ? 1 : 0.4, y: done(i) ? 0 : (above ? -4 : 4) }} transition={{ duration: 0.4 }}
                style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', width: 170,
                  [above ? 'bottom' : 'top']: 42 }}>
                <div className="card" style={{ padding: '12px 14px', borderTop: above ? undefined : `3px solid ${done(i) ? 'var(--accent)' : 'var(--line-2)'}`, borderBottom: above ? `3px solid ${done(i) ? 'var(--accent)' : 'var(--line-2)'}` : undefined }}>
                  <div className="row center gap-s" style={{ marginBottom: 4 }}>
                    <span style={{ fontSize: 16 }}>{st.g}</span>
                    <b style={{ fontSize: 14 }}>{st.t}</b>
                  </div>
                  <p style={{ fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.4 }}>{st.s}</p>
                  {i === STATIONS.length - 1 && done(i) && (
                    <span className="badge-live" style={{ fontSize: 10, marginTop: 8 }}>live</span>
                  )}
                </div>
              </motion.div>
            </div>
          );
        })}
      </div>

      <div className="row center" style={{ justifyContent: 'center' }}>
        <span className="muted" style={{ fontSize: 14, textAlign: 'center', maxWidth: '60ch' }}>
          Config only — <b style={{ color: 'var(--ink)' }}>no code, no infrastructure spun up per project.</b> A new business is live in minutes.
        </span>
      </div>
    </div>
  );
}
