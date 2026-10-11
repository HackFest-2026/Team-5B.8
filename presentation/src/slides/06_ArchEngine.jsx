import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Head } from '../ui.jsx';

/*
 * Slide 5 — the general-purpose engine.
 * Clean left→right hierarchy: three identical input nodes → engine → price out.
 *
 * Connectors are drawn in a px-for-px SVG matching the diagram container. Every
 * endpoint is MEASURED from the real rendered chips (getBoundingClientRect,
 * converted into container space) and recomputed on resize — so the orange
 * curves always meet the engine's LEFT edge at the chip's vertical centre, and
 * the green line runs engine-RIGHT-edge → price-card-LEFT-edge, at any width or
 * aspect ratio. A short settle pass re-measures while the entrance animates.
 */
const INPUTS = [
  { key: 'item',    cy: 0.12, glyph: '📦', title: 'Item signals',    ex: 'base · stock' },
  { key: 'overall', cy: 0.44, glyph: '🌐', title: 'Overall signals', ex: 'demand · season' },
  { key: 'request', cy: 0.76, glyph: '🙋', title: 'Request signals',  ex: 'location · device' },
];
const IN_CX = 0.15, ENG_CX = 0.47, ENG_CY = 0.44, PRICE_CX = 0.84, PRICE_CY = 0.44;
const ENGINE = 96, PRICE_SZ = 108;           // real node sizes (px)
const NEARBY = [6000, 6150, 5940, 6080, 5990, 6220, 5880, 6040];

export default function ArchEngine() {
  const boxRef = useRef(null);
  const inRefs = useRef([]);
  const engRef = useRef(null);
  const priceRef = useRef(null);
  const [geom, setGeom] = useState(null);
  const [p, setP] = useState(6000);

  // Measure the rendered chips relative to the container, in container px.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;

    const measure = () => {
      const c = box.getBoundingClientRect();
      const rel = (r) => r && { l: r.left - c.left, r: r.right - c.left, t: r.top - c.top, b: r.bottom - c.top };
      const eng = rel(engRef.current?.getBoundingClientRect());
      const price = rel(priceRef.current?.getBoundingClientRect());
      const inputs = inRefs.current.map((el) => el && rel(el.getBoundingClientRect()));
      if (!eng || !price || inputs.some((x) => !x)) return;
      setGeom({
        w: c.width, h: c.height,
        inputs: inputs.map((i) => ({ x: i.r, y: (i.t + i.b) / 2 })),       // right-edge, mid
        engL: { x: eng.l, y: (eng.t + eng.b) / 2 },                         // left-edge, mid
        engR: { x: eng.r, y: (eng.t + eng.b) / 2 },                         // right-edge, mid
        priceL: { x: price.l, y: (price.t + price.b) / 2 },                 // left-edge, mid
      });
    };

    measure();
    // settle: re-measure while the entrance animation (scale/translate) plays
    let raf, stop = false;
    const t0 = performance.now();
    const loop = () => { if (stop) return; measure(); if (performance.now() - t0 < 1400) raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);

    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => { stop = true; cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  // live price (nearby jumps)
  useEffect(() => {
    let i = 0;
    const id = setInterval(() => { i = (i + 1) % NEARBY.length; setP(NEARBY[i]); }, 900);
    return () => clearInterval(id);
  }, []);

  // smooth, symmetrical curve from an input's right edge to the engine's left edge
  const curve = (a, b) => {
    const dx = (b.x - a.x) * 0.5;
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <Head no="05" eyebrow="How one engine fits any business"
        title={<>Three kinds of signal. <span className="hl">One engine.</span></>} sm />

      <div ref={boxRef} style={{ position: 'relative', height: 'min(52vh, 400px)', margin: '0 auto', width: '100%', maxWidth: 1320 }}>
        {/* connectors — measured, px-for-px with the container */}
        {geom && (
          <svg width={geom.w} height={geom.h} viewBox={`0 0 ${geom.w} ${geom.h}`} style={{ position: 'absolute', inset: 0 }}>
            {geom.inputs.map((a, i) => <path key={i} className="fline flow" d={curve(a, geom.engL)} />)}
            <path className="fline flow good" d={`M ${geom.engR.x} ${geom.engR.y} L ${geom.priceL.x} ${geom.priceL.y}`} />
          </svg>
        )}

        {/* identical input nodes (centre-anchored) */}
        {INPUTS.map((l, i) => (
          <motion.div key={l.key} className="fnode on" style={{ left: `${IN_CX * 100}%`, top: `${l.cy * 100}%` }}
            initial={{ opacity: 0, x: -14 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.1, duration: 0.5 }}>
            <div className="chip" ref={(el) => (inRefs.current[i] = el)} style={{ fontSize: 26 }}>{l.glyph}</div>
            <div className="lab">{l.title}</div>
            <div className="sub">{l.ex}</div>
          </motion.div>
        ))}

        {/* engine — concentric chip + ring + glow, centre-anchored */}
        <motion.div style={{ position: 'absolute', left: `${ENG_CX * 100}%`, top: `${ENG_CY * 100}%`, transform: 'translate(-50%,-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}
          initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.4, duration: 0.5 }}>
          <div ref={engRef} style={{ position: 'relative', width: ENGINE, height: ENGINE }}>
            <motion.div style={{ position: 'absolute', inset: -13, borderRadius: '50%', border: '2px dashed var(--line-2)' }}
              animate={{ rotate: 360 }} transition={{ duration: 6, repeat: Infinity, ease: 'linear' }} />
            <div style={{ position: 'absolute', inset: 0, borderRadius: 25, background: 'var(--ink-grad)', color: '#fff', display: 'grid', placeItems: 'center', boxShadow: '0 0 0 10px var(--accent-soft), var(--shadow-l)' }}>
              <motion.span style={{ fontSize: 38 }} animate={{ rotate: 360 }} transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}>⚙</motion.span>
            </div>
          </div>
          <div className="lab" style={{ marginTop: 2 }}>DevNexus Engine</div>
          <div className="sub">processing…</div>
        </motion.div>

        {/* price out — centre-anchored, aligned to the engine centreline */}
        <motion.div className="fnode on" style={{ left: `${PRICE_CX * 100}%`, top: `${PRICE_CY * 100}%` }}
          initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.65, duration: 0.5 }}>
          <div className="chip" ref={priceRef} style={{ width: PRICE_SZ, height: PRICE_SZ, borderRadius: 26, borderColor: 'var(--good)', flexDirection: 'column', gap: 3 }}>
            <motion.span key={p} className="statnum" style={{ fontSize: 25, color: 'var(--good)' }}
              initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
              ₹{p.toLocaleString('en-IN')}
            </motion.span>
            <span className="mono" style={{ fontSize: 9, color: 'var(--ink-3)' }}>live · + why</span>
          </div>
          <div className="lab">Price out</div>
        </motion.div>
      </div>

      <p className="muted" style={{ fontSize: 15, textAlign: 'center', maxWidth: '88ch', margin: '0 auto', lineHeight: 1.5, textWrap: 'balance' }}>
        No industry is hard-coded. Every business describes its inputs as <b style={{ color: 'var(--ink)' }}>item, overall and request</b> — and the same engine prices it, live.
      </p>
    </div>
  );
}
