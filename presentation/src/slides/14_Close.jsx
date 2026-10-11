import React from 'react';
import { motion } from 'framer-motion';
import { Reveal } from '../ui.jsx';

const RECAP = [
  'One engine, any business — nothing hard-coded to an industry',
  'Configure → simulate → publish → operate, with no code',
  'Live on AWS, pricing in single-digit milliseconds',
  'Explainable, deterministic, and watched by a human',
];

export default function Close() {
  return (
    <div className="col" style={{ gap: 'clamp(20px,2.4vw,34px)' }}>
      <Reveal><div className="eyebrow"><span className="no">14</span> The takeaway</div></Reveal>

      <Reveal delay={0.08}>
        <h1 className="display">
          A new industry?<br /><span className="hl">Just configuration.</span>
        </h1>
      </Reveal>

      <Reveal delay={0.2}>
        <p className="lead">
          Hand us a domain we’ve never seen — car rental, insurance, anything. Describe its
          signals as <b>item, overall and request</b>, write a few rules and limits, and it
          prices. <b>No engine change. No deploy.</b> That’s the whole point.
        </p>
      </Reveal>

      <Reveal delay={0.34} className="row wrap" style={{ gap: 12 }}>
        {RECAP.map((r, n) => (
          <motion.span key={n} className="pill" style={{ fontSize: 13 }}
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 + n * 0.08 }}>
            <span style={{ color: 'var(--accent)', fontWeight: 800 }}>✓</span> {r}
          </motion.span>
        ))}
      </Reveal>

      <Reveal delay={0.72} className="row wrap center" style={{ gap: 26, marginTop: 8 }}>
        <div className="col" style={{ gap: 2 }}>
          <span className="slide-label">Live API</span>
          <span className="mono" style={{ fontSize: 14 }}>ht1rtpk2jj.execute-api.ap-south-1.amazonaws.com</span>
        </div>
        <div className="col" style={{ gap: 2 }}>
          <span className="slide-label">Console</span>
          <span className="mono" style={{ fontSize: 14 }}>devnexus-a7z.pages.dev</span>
        </div>
        <span className="badge-live">not a prototype — a working product</span>
      </Reveal>

      <Reveal delay={0.95}>
        <h2 className="title" style={{ fontSize: 'clamp(22px,2.2vw,36px)', color: 'var(--ink-4)' }}>
          DevNexus — <span style={{ color: 'var(--ink)' }}>pricing, finally reusable.</span>
        </h2>
      </Reveal>
    </div>
  );
}
