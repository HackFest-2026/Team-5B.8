import React from 'react';
import { motion } from 'framer-motion';
import { Head } from '../ui.jsx';

const COLS = [
  { h: 'Secure', g: '🔒', accent: 'var(--accent)', pts: [
    'Revocable session tokens, stored server-side',
    'Per-project API keys, rotatable in one call',
    'Tenant data fully isolated by design',
    'Hot path can’t reach secrets — walled by IAM',
  ] },
  { h: 'Reliable', g: '🛡️', accent: '#2E6BE6', pts: [
    'Always returns a price — safe fallback, never an error',
    'Every decision replayable & reproducible',
    'Dead-letter nets + idempotent events',
    'Big changes gated by human approval + audit',
  ] },
  { h: 'Scalable', g: '📈', accent: 'var(--good)', pts: [
    'Serverless — scales out, and to zero',
    'Pricing table isolated from analytics load',
    'Cache on the hottest lookups',
    'Spikes absorbed by queues, not dropped',
  ] },
];

export default function Quality() {
  return (
    <div>
      <Head no="13" eyebrow="Why you can trust it"
        title={<>Built like it’s <span className="hl">handling real money.</span></>} sm />

      <div className="row wrap" style={{ gap: 18, alignItems: 'stretch' }}>
        {COLS.map((c, ci) => (
          <motion.div key={c.h} className="card col grow" style={{ flexBasis: 300, minWidth: 270, padding: 20, gap: 14, borderTop: `4px solid ${c.accent}` }}
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + ci * 0.12, duration: 0.5 }}>
            <div className="row center gap-s">
              <span style={{ fontSize: 24, width: 44, height: 44, borderRadius: 12, display: 'grid', placeItems: 'center', background: 'var(--paper)' }}>{c.g}</span>
              <h3 style={{ fontFamily: 'var(--display)', fontWeight: 800, fontSize: 'clamp(22px,2vw,30px)', letterSpacing: '-.02em' }}>{c.h}</h3>
            </div>
            <div className="col" style={{ gap: 9 }}>
              {c.pts.map((p, n) => (
                <motion.div key={n} className="row gap-s" style={{ alignItems: 'flex-start', background: 'var(--paper)', borderRadius: 10, padding: '11px 13px' }}
                  initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.3 + ci * 0.12 + n * 0.07 }}>
                  <span style={{ color: c.accent, fontWeight: 800, flex: 'none', marginTop: 1 }}>✓</span>
                  <span style={{ fontSize: 'clamp(13.5px,1.08vw,16px)', lineHeight: 1.4, fontWeight: 500, color: 'var(--ink)' }}>{p}</span>
                </motion.div>
              ))}
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
