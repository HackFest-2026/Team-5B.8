import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Head } from '../ui.jsx';
import { useLoop } from '../useLoop.js';

/*
 * Architecture 4 — context in → price out. Loops through 4 domains fast, so the
 * same engine is seen pricing very different things. Tight layout, little space.
 */
const CASES = [
  { tag: 'Hotel', req: ['item · ROOM_204', 'overall · demand=high', 'request · nights=3'],
    res: [['Base', '5,000'], ['+ demand', '+1,000'], ['− loyalty', '−400'], ['Final', '₹5,600']] },
  { tag: 'Ride', req: ['item · RIDE_X', 'overall · surge=1.8', 'request · distance=8km'],
    res: [['Base', '150'], ['× surge', '+120'], ['+ night', '+30'], ['Final', '₹300']] },
  { tag: 'Lending', req: ['item · LOAN_A', 'overall · repo=6.5%', 'request · risk=low'],
    res: [['Base', '9.0%'], ['+ risk', '+2.0%'], ['− relationship', '−0.5%'], ['Final', '10.5%']] },
  { tag: 'Retail', req: ['item · SKU_42', 'overall · demand=low', 'request · member=yes'],
    res: [['Base', '2,000'], ['− clearance', '−300'], ['− member', '−100'], ['Final', '₹1,600']] },
];

export default function ArchPrice() {
  const idx = useLoop(CASES.length - 1, 1700); // 0..3 looping
  const c = CASES[idx];

  return (
    <div className="col" style={{ gap: 14 }}>
      <Head no="08" eyebrow="How the pricing API works"
        title={<>A request in. A price — <span className="hl">and the why</span> — out.</>} sm
        right={<span className="badge-live">~4 ms p50</span>} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 150px auto 1fr', alignItems: 'center', gap: 'clamp(8px,1.6vw,26px)', maxWidth: 1180, width: '100%', margin: '0 auto' }}>
        {/* request */}
        <div style={{ position: 'relative', minHeight: 230 }}>
          <AnimatePresence mode="wait">
            <motion.div key={idx} className="card col" style={{ padding: 18, gap: 9, borderLeft: '3px solid var(--accent)' }}
              initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 16 }} transition={{ duration: 0.3 }}>
              <div className="row between center"><span className="mono" style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent-ink)' }}>GET /price</span><span className="pill accent" style={{ fontSize: 10 }}>{c.tag}</span></div>
              {c.req.map((r) => <div key={r} className="mono" style={{ fontSize: 12, color: 'var(--ink-3)', background: 'var(--paper)', padding: '7px 10px', borderRadius: 8 }}>{r}</div>)}
              <span className="muted" style={{ fontSize: 12 }}>the three scopes, carried in</span>
            </motion.div>
          </AnimatePresence>
        </div>

        <svg width="100%" height="12" viewBox="0 0 100 12" preserveAspectRatio="none" style={{ minWidth: 36 }}><path className="fline flow" d="M 0 6 L 100 6" style={{ strokeWidth: 2.5 }} /></svg>

        {/* engine */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          <div style={{ position: 'relative', width: 90, height: 90 }}>
            <motion.div style={{ position: 'absolute', inset: -12, borderRadius: '50%', border: '2px dashed var(--line-2)' }} animate={{ rotate: 360 }} transition={{ duration: 5, repeat: Infinity, ease: 'linear' }} />
            <motion.div style={{ position: 'absolute', inset: 0, borderRadius: 24, background: 'var(--ink-grad)', color: '#fff', display: 'grid', placeItems: 'center', boxShadow: '0 0 0 7px var(--accent-soft), var(--shadow-l)' }} animate={{ scale: [1, 1.05, 1] }} transition={{ duration: 1.2, repeat: Infinity }}>
              <motion.span style={{ fontSize: 34 }} animate={{ rotate: 360 }} transition={{ duration: 2.2, repeat: Infinity, ease: 'linear' }}>⚙</motion.span>
            </motion.div>
          </div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Engine</div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--ink-4)' }}>rules → guardrails</div>
        </div>

        <svg width="100%" height="12" viewBox="0 0 100 12" preserveAspectRatio="none" style={{ minWidth: 36 }}><path className="fline flow good" d="M 0 6 L 100 6" style={{ strokeWidth: 2.5 }} /></svg>

        {/* response */}
        <div style={{ position: 'relative', minHeight: 230 }}>
          <AnimatePresence mode="wait">
            <motion.div key={idx} className="card col" style={{ padding: 18, gap: 7, borderColor: 'var(--good)' }}
              initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} transition={{ duration: 0.3 }}>
              <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: 'var(--good)' }}>200 · explainable</span>
              {c.res.map((d, i) => (
                <div key={d[0]} className="row between" style={{ fontSize: 13, paddingBottom: 5, borderBottom: i < 3 ? '1px solid var(--line)' : 'none' }}>
                  <span style={{ fontWeight: i === 3 ? 800 : 500 }}>{d[0]}</span>
                  <span className="mono" style={{ fontWeight: 700, fontSize: i === 3 ? 17 : 13, color: i === 3 ? 'var(--ink)' : i > 0 && i < 3 ? 'var(--accent-ink)' : 'var(--ink-2)' }}>{d[1]}</span>
                </div>
              ))}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      <div className="row center" style={{ justifyContent: 'center' }}>
        <span className="muted" style={{ fontSize: 15, textAlign: 'center', maxWidth: '76ch' }}>
          Same engine, any domain — hotel, ride, loan, retail. A GET comes in → it prices deterministically → the response carries the price <b style={{ color: 'var(--ink)' }}>and the reasons behind it.</b>
        </span>
      </div>
    </div>
  );
}
