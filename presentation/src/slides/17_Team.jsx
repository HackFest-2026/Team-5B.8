import React from 'react';
import { motion } from 'framer-motion';
import { Head } from '../ui.jsx';

const TEAM = [
  { name: 'Mohammad Sadiq', initials: 'MS', roles: ['Lead', 'System design', 'Backend', 'Cloud', 'Research', 'Android'] },
  { name: 'Fazle Moin', initials: 'FM', roles: ['Android app'] },
  { name: 'Owais Aminbhavi', initials: 'OA', roles: ['React website'] },
  { name: 'Abdul', initials: 'A', roles: ['React website'] },
];

function Chip({ label, lead }) {
  return (
    <span style={{
      fontFamily: 'var(--sans)', fontSize: 12, fontWeight: 600, letterSpacing: '-.005em',
      padding: '5px 12px', borderRadius: 999, lineHeight: 1,
      color: lead ? '#fff' : 'var(--ink-2)',
      background: lead ? 'var(--accent)' : 'var(--paper)',
      border: lead ? '1px solid var(--accent)' : '1px solid var(--line-2)',
      boxShadow: lead ? '0 2px 8px rgba(225,81,43,.25)' : 'none',
    }}>{label}</span>
  );
}

export default function Team() {
  return (
    <div className="col" style={{ gap: 'clamp(22px,2.6vw,38px)' }}>
      <Head no="14" eyebrow="Who built it"
        title={<>Team &amp; <span className="hl">contribution.</span></>} sm />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 20, alignItems: 'stretch' }}>
        {TEAM.map((m, n) => (
          <motion.div key={m.name} className="card row" style={{ padding: 'clamp(20px,1.8vw,28px)', gap: 20, alignItems: 'center', borderLeft: '4px solid var(--accent)' }}
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 + n * 0.1, duration: 0.5 }}>
            <div style={{ width: 72, height: 72, borderRadius: 20, background: 'var(--ink-grad)', color: '#fff', display: 'grid', placeItems: 'center', fontFamily: 'var(--display)', fontWeight: 800, fontSize: 27, flex: 'none' }}>{m.initials}</div>
            <div className="col" style={{ gap: 12, minWidth: 0 }}>
              <span style={{ fontFamily: 'var(--display)', fontWeight: 800, fontSize: 'clamp(19px,1.6vw,26px)', letterSpacing: '-.02em', lineHeight: 1.05 }}>{m.name}</span>
              <div className="row wrap" style={{ gap: 8 }}>
                {m.roles.map((r, i) => <Chip key={r} label={r} lead={i === 0 && m.roles.length > 1} />)}
              </div>
            </div>
          </motion.div>
        ))}
      </div>

      <motion.div className="row center" style={{ justifyContent: 'center', marginTop: 2 }}
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.7 }}>
        <span style={{ fontFamily: 'var(--display)', fontWeight: 800, fontSize: 'clamp(18px,1.8vw,26px)', color: 'var(--ink-4)' }}>
          DevNexus — <span style={{ color: 'var(--ink)' }}>thank you.</span>
        </span>
      </motion.div>
    </div>
  );
}
