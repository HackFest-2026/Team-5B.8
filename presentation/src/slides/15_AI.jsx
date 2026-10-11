import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Head } from '../ui.jsx';

/*
 * How the AI works. Animates in, stays active, lines keep flowing.
 * Input (left) → AI core (centre) → four drafts (right). Clean alignment.
 */
const OUTPUTS = [
  { y: 15, g: '🧩', t: 'Schema', s: 'suggests the signals to track' },
  { y: 38, g: '⚖️', t: 'Rules',  s: 'drafts IF / THEN rules + limits' },
  { y: 62, g: '🧪', t: 'Test cases', s: 'generates cases to validate them' },
  { y: 85, g: '🔔', t: 'Alerts',  s: 'writes the question + safe options' },
];
const PROMPTS = [
  { kind: 'a rule', text: '“Raise price when demand is high, but keep it under ₹10,000.”' },
  { kind: 'a test case', text: '“If stock drops below 5, the price should rise at least 10%.”' },
  { kind: 'a command', text: '“Make weekends 15% cheaper for loyalty members.”' },
];
const CORE = { x: 37, y: 50 }, IN = { x: 13, y: 50 }, OUT_X = 64;

export default function AIArch() {
  const [pi, setPi] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setPi((n) => (n + 1) % PROMPTS.length), 2200);
    return () => clearInterval(id);
  }, []);
  const prompt = PROMPTS[pi];

  return (
    <div className="col" style={{ gap: 8 }}>
      <Head no="08" eyebrow="The AI layer"
        title={<>AI that <span className="hl">sets it up</span> — never prices.</>} sm
        right={<span className="pill accent">drafts only · you approve</span>} />

      <div style={{ position: 'relative', height: 'min(62vh, 480px)' }}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
          <path className="fline flow" d={`M ${IN.x + 9} ${IN.y} L ${CORE.x - 8} ${CORE.y}`} />
          {OUTPUTS.map((o, i) => (
            <path key={i} className="fline flow" d={`M ${CORE.x + 8} ${CORE.y} C ${CORE.x + 16} ${CORE.y}, ${OUT_X - 10} ${o.y}, ${OUT_X - 1} ${o.y}`} />
          ))}
        </svg>

        {/* cycling prompt in */}
        <div style={{ position: 'absolute', left: `${IN.x}%`, top: `${IN.y}%`, transform: 'translate(-50%,-50%)', width: 'min(22%,220px)' }}>
          <div className="card" style={{ padding: '13px 15px', borderLeft: '3px solid var(--accent)', minHeight: 116 }}>
            <AnimatePresence mode="wait">
              <motion.div key={pi} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.3 }}>
                <span className="mono" style={{ fontSize: 10, color: 'var(--accent-ink)', fontWeight: 700 }}>you give it {prompt.kind}</span>
                <p style={{ fontSize: 12.5, lineHeight: 1.45, marginTop: 6 }}>{prompt.text}</p>
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        {/* AI core */}
        <div style={{ position: 'absolute', left: `${CORE.x}%`, top: `${CORE.y}%`, transform: 'translate(-50%,-50%)' }}>
          {[0, 1, 2].map((r) => (
            <motion.div key={r} style={{ position: 'absolute', inset: -10, borderRadius: '50%', border: '1.5px solid var(--accent)' }}
              animate={{ scale: [1, 1.8], opacity: [0.5, 0] }} transition={{ duration: 1.8, repeat: Infinity, delay: r * 0.5, ease: 'easeOut' }} />
          ))}
          <motion.div style={{ width: 112, height: 112, borderRadius: 28, background: 'var(--ink-grad)', color: '#fff', display: 'grid', placeItems: 'center', boxShadow: '0 0 0 8px var(--accent-soft), var(--shadow-l)', position: 'relative' }}
            animate={{ scale: [1, 1.04, 1] }} transition={{ duration: 1.4, repeat: Infinity }}>
            <div className="col center" style={{ gap: 3 }}>
              <motion.span style={{ fontSize: 30, color: 'var(--accent-2)' }} animate={{ rotate: [0, 15, -15, 0], scale: [1, 1.15, 1] }} transition={{ duration: 1.8, repeat: Infinity }}>✦</motion.span>
              <b style={{ fontFamily: 'var(--display)', fontSize: 15 }}>AI agent</b>
              <span className="mono" style={{ fontSize: 9, opacity: .75 }}>understand · draft</span>
            </div>
          </motion.div>
        </div>

        {/* outputs — left edge anchored at OUT_X% */}
        {OUTPUTS.map((o, i) => (
          <motion.div key={o.t} style={{ position: 'absolute', left: `${OUT_X}%`, top: `${o.y}%`, transform: 'translateY(-50%)', width: 'min(30%,260px)' }}
            initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.2 + i * 0.1, duration: 0.45 }}>
            <div className="card row gap-s center" style={{ padding: '12px 15px', borderLeft: '3px solid var(--accent)' }}>
              <span style={{ fontSize: 20, flex: 'none' }}>{o.g}</span>
              <div className="col" style={{ gap: 1 }}><b style={{ fontSize: 14.5 }}>{o.t}</b><span className="muted" style={{ fontSize: 11.5 }}>{o.s}</span></div>
            </div>
          </motion.div>
        ))}
      </div>

      <div className="row center" style={{ justifyContent: 'center' }}>
        <span className="muted" style={{ fontSize: 15, textAlign: 'center', maxWidth: '78ch' }}>
          The AI turns plain English — a rule, a test case, a command — into <b style={{ color: 'var(--ink)' }}>draft configuration</b> you review and approve. The engine stays <b style={{ color: 'var(--ink)' }}>100% deterministic</b>.
        </span>
      </div>
    </div>
  );
}
