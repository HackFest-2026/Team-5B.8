import React from 'react';
import { motion } from 'framer-motion';
import { Head, Reveal } from '../ui.jsx';

const CHAIN = [
  { k: 'Assume', v: '1,000', u: 'businesses', s: 'our planning target' },
  { k: '× ~5,000 items each', v: '~5M', u: 'priced items', s: 'catalogue under management' },
  { k: '× ~20 req/s busy hour', v: '~20K', u: 'prices / sec', s: 'peak pricing load' },
  { k: '× ~5 events / price', v: '~100K', u: 'events / sec', s: 'queued — never dropped' },
];

export default function Envelope() {
  return (
    <div>
      <Head no="12" eyebrow="Back-of-the-envelope"
        title={<>Does it scale? <span className="hl">Let’s do the maths.</span></>} />

      <div className="row wrap center" style={{ gap: 12 }}>
        {CHAIN.map((c, n) => (
          <React.Fragment key={n}>
            <motion.div className="card col" style={{ padding: '18px 22px', gap: 4, flex: '1 1 180px', minWidth: 170 }}
              initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 + n * 0.14, duration: 0.55 }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--ink-4)' }}>{c.k}</span>
              <div className="statnum" style={{ fontSize: 'clamp(26px,3vw,46px)' }}>{c.v}<span className="u">{c.u}</span></div>
              <span className="muted" style={{ fontSize: 12 }}>{c.s}</span>
            </motion.div>
            {n < CHAIN.length - 1 && (
              <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 + n * 0.14 }} style={{ color: 'var(--accent)', fontSize: 24, fontWeight: 800 }}>→</motion.span>
            )}
          </React.Fragment>
        ))}
      </div>

      <Reveal delay={0.85} className="row wrap mt-l" style={{ gap: 16 }}>
        <div className="tile grow" style={{ flexBasis: 300 }}>
          <h3>So how much compute?</h3>
          <p>One price = <b>one database read + pure CPU ≈ 4 ms</b> → ~200 prices/sec per worker. 20K/sec ≈ <b>~100 parallel functions</b> — well inside default AWS limits, and <b>zero</b> when idle.</p>
        </div>
        <div className="tile grow" style={{ flexBasis: 300 }}>
          <h3>Why it keeps holding</h3>
          <p>The hot path is <b>stateless and serverless</b> — more load just means more functions. Spikes sit in a queue, and old decisions auto-expire at 90 days, so <b>storage stays bounded</b>.</p>
        </div>
      </Reveal>
    </div>
  );
}
