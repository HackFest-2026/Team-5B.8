import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Head } from '../ui.jsx';

/*
 * Slide 6 — how the engine prices one request, as a single horizontal flow.
 * A glowing packet travels stage → stage; each stage lights up and reveals its
 * real result inline (rules turn green, guardrails get a ✓, the price lands).
 * Stepped. Nothing faked — the only cache is the real in-memory key lookup.
 */
const EASE = [0.22, 0.61, 0.36, 1];
const NODES = [
  { x: 10, g: '📥', t: 'Request',    s: 'GET /price' },
  { x: 31, g: '🔎', t: 'Look up',    s: 'key cached · 1 read' },
  { x: 52, g: '⚖️', t: 'Rules',      s: 'match → adjust' },
  { x: 73, g: '🛡️', t: 'Guardrails', s: 'clamp to limits' },
  { x: 92, g: '₹',  t: 'Price',      s: 'value + why', good: true },
];
const FLOW_Y = 40;
const CAPTION = {
  0: 'Follow one real price request through the engine — press → to run it.',
  1: 'A request arrives: the item ROOM_204 and its live signals (demand = high, nights = 3).',
  2: 'The API key is resolved from the in-memory cache; one DynamoDB read loads the rules, signals and item — base ₹5,000.',
  3: 'Each rule is checked against the signals. Matching rules turn green and adjust the price in priority order.',
  4: 'Guardrails clamp the result inside the safe limits — here it is already within range, so the price holds.',
  5: 'The response carries the final price and every driver behind it — explained, in about 4 ms.',
};

function Dot({ good }) {
  return (
    <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 400, damping: 15 }}
      style={{ width: 20, height: 20, borderRadius: '50%', background: good ? 'var(--good)' : 'var(--accent)', display: 'grid', placeItems: 'center', color: '#fff', fontSize: 12, fontWeight: 800, flex: 'none' }}>✓</motion.span>
  );
}

export default function EngineWorks({ step }) {
  const active = (i) => step >= i + 1;
  const done = (i) => step > i + 1;
  const seg = (i) => step >= i + 2;              // connector node i → i+1
  const packetX = step >= 1 ? NODES[Math.min(step, 5) - 1].x : NODES[0].x;

  return (
    <div className="col" style={{ gap: 'clamp(16px,2vw,26px)' }}>
      <Head no="06" eyebrow="The core — how the engine prices"
        title={<>Inside the engine: <span className="hl">request → price.</span></>} sm
        right={<span className="pill">{step}/5</span>} />

      <div style={{ position: 'relative', height: 'min(56vh, 430px)' }}>
        {/* connectors */}
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
          {NODES.slice(0, -1).map((n, i) => (
            <path key={i} className={`fline ${seg(i) ? 'flow' : ''} ${seg(i) && i === 3 ? 'good' : ''}`}
              d={`M ${n.x} ${FLOW_Y} L ${NODES[i + 1].x} ${FLOW_Y}`} />
          ))}
        </svg>

        {/* travelling packet: glides from the previous stage into the current
            one and fades (absorbed), so it never sits on top of an icon */}
        {step >= 1 && (
          <motion.span key={step} aria-hidden
            style={{ position: 'absolute', top: `${FLOW_Y}%`, width: 15, height: 15, marginLeft: -7.5, marginTop: -7.5, borderRadius: '50%',
              background: step >= 5 ? 'var(--good)' : 'var(--accent)', zIndex: 3,
              boxShadow: step >= 5 ? '0 0 16px 3px rgba(30,122,80,.55)' : '0 0 16px 3px rgba(225,81,43,.5)' }}
            initial={{ left: `${step >= 2 ? NODES[step - 2].x : NODES[0].x}%`, opacity: 0, scale: 0.6 }}
            animate={{ left: `${packetX}%`, opacity: [0, 1, 1, 0], scale: [0.6, 1.2, 1, 0.7] }}
            transition={{ duration: 0.85, ease: EASE, times: [0, 0.2, 0.7, 1] }} />
        )}

        {/* nodes */}
        {NODES.map((n, i) => (
          <div key={i} style={{ position: 'absolute', left: `${n.x}%`, top: `${FLOW_Y}%`, transform: 'translate(-50%,-50%)', zIndex: 2, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <motion.div
              animate={{
                opacity: active(i) ? 1 : 0.34,
                scale: step === i + 1 ? 1.06 : 1,
                borderColor: active(i) ? (n.good ? 'var(--good)' : 'var(--line)') : 'var(--line-2)',
                boxShadow: step === i + 1
                  ? (n.good ? '0 0 0 7px var(--good-soft), var(--shadow-m)' : '0 0 0 7px var(--accent-soft), var(--shadow-m)')
                  : (active(i) ? 'var(--shadow-m)' : 'var(--shadow-s)'),
              }}
              transition={{ duration: 0.35 }}
              style={{ width: 74, height: 74, borderRadius: 20, display: 'grid', placeItems: 'center', background: 'var(--card)', border: '1.5px solid var(--line-2)', position: 'relative' }}>
              <span style={{ fontSize: n.g === '₹' ? 30 : 28, fontWeight: n.g === '₹' ? 800 : 400, fontFamily: n.g === '₹' ? 'var(--display)' : undefined, color: n.good && active(i) ? 'var(--good)' : undefined }}>{n.g}</span>
              <AnimatePresence>
                {done(i) && (
                  <motion.span key="d" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }}
                    style={{ position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: '50%', background: 'var(--good)', color: '#fff', display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 800, boxShadow: 'var(--shadow-s)' }}>✓</motion.span>
                )}
              </AnimatePresence>
            </motion.div>
            <motion.div animate={{ opacity: active(i) ? 1 : 0.4 }} style={{ textAlign: 'center', marginTop: 10 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: active(i) ? 'var(--ink)' : 'var(--ink-3)' }}>{n.t}</div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--ink-4)', marginTop: 2 }}>{n.s}</div>
            </motion.div>

            {/* per-stage inline result */}
            <div style={{ position: 'absolute', top: '100%', marginTop: 54, width: 220, display: 'flex', justifyContent: 'center' }}>
              <AnimatePresence>
                {active(i) && <StageResult key={i} i={i} step={step} />}
              </AnimatePresence>
            </div>
          </div>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.p key={step} className="muted" style={{ fontSize: 15, textAlign: 'center', maxWidth: '82ch', margin: '0 auto', lineHeight: 1.5, textWrap: 'balance' }}
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
          {CAPTION[step]}
        </motion.p>
      </AnimatePresence>
    </div>
  );
}

function Chip({ children, tone = 'ink', delay = 0 }) {
  const c = tone === 'good' ? { bg: 'var(--good-soft)', bd: 'var(--good)', fg: 'var(--good)' }
    : tone === 'mute' ? { bg: 'var(--paper)', bd: 'var(--line-2)', fg: 'var(--ink-4)' }
    : { bg: 'var(--card)', bd: 'var(--line-2)', fg: 'var(--ink-2)' };
  return (
    <motion.span initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ delay, duration: 0.35 }}
      className="mono" style={{ fontSize: 11.5, fontWeight: 600, color: c.fg, background: c.bg, border: `1px solid ${c.bd}`, borderRadius: 999, padding: '5px 11px', whiteSpace: 'nowrap', boxShadow: 'var(--shadow-s)' }}>
      {children}
    </motion.span>
  );
}

function StageResult({ i, step }) {
  if (i === 0) return <Chip>item + 3 signals</Chip>;
  if (i === 1) return <Chip tone="good">base ₹5,000 ✓</Chip>;
  if (i === 2) return (
    <div className="col center" style={{ gap: 6 }}>
      <Chip tone="good" delay={0.1}>demand = high → +20% ✓</Chip>
      <Chip tone="mute" delay={0.25}>nights ≥ 7 → skipped ✗</Chip>
    </div>
  );
  if (i === 3) return <Chip tone="good">within limits · no clamp ✓</Chip>;
  // price — count up to 6,000
  return <PriceResult show={step >= 5} />;
}

function PriceResult({ show }) {
  const [v, setV] = React.useState(5000);
  React.useEffect(() => {
    if (!show) return;
    let raf, t0;
    const run = (t) => { if (!t0) t0 = t; const k = Math.min(1, (t - t0) / 600); setV(Math.round(5000 + 1000 * k)); if (k < 1) raf = requestAnimationFrame(run); };
    raf = requestAnimationFrame(run);
    return () => cancelAnimationFrame(raf);
  }, [show]);
  return (
    <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.35 }}
      className="col center" style={{ gap: 3 }}>
      <div className="statnum" style={{ fontSize: 30, color: 'var(--good)' }}>₹{v.toLocaleString('en-IN')}</div>
      <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-4)' }}>DEC-7K2P9X · explained</span>
    </motion.div>
  );
}
