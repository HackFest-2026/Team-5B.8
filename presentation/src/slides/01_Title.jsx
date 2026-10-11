import React from 'react';
import { motion } from 'framer-motion';
import { Reveal } from '../ui.jsx';
import { BrandIcon } from '../brand-icons.jsx';

const STACK = ['Python', 'FastAPI', 'AWS', 'Lambda', 'DynamoDB', 'Redis', 'Flutter', 'React'];

export default function Title() {
  return (
    <div className="col" style={{ gap: 'clamp(20px,2.6vw,36px)' }}>
      <Reveal>
        <div className="eyebrow"><span className="no">DevNexus</span> Hackathon final · built · deployed · running</div>
      </Reveal>

      <Reveal delay={0.08}>
        <h1 className="display">
          One pricing engine.<br />
          <span className="hl">Every</span> business.<br />
          <span className="soft">Zero code.</span>
        </h1>
      </Reveal>

      <Reveal delay={0.24}>
        <p className="lead">
          A complete, working platform that lets <b>any</b> business configure, test and run
          live dynamic prices — through one engine, one API and one dashboard. Live on AWS,
          pricing in <b>single-digit milliseconds</b>.
        </p>
      </Reveal>

      <Reveal delay={0.36} className="row wrap center" style={{ gap: 12, marginTop: 4 }}>
        {STACK.map((b, n) => (
          <motion.span key={b} className="pill" style={{ gap: 8 }}
            initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.46 + n * 0.05 }}>
            <BrandIcon name={b} size={16} /> {b}
          </motion.span>
        ))}
      </Reveal>

      <Reveal delay={0.8} className="row wrap" style={{ gap: 30, marginTop: 8, color: 'var(--ink-3)' }}>
        <span className="mono" style={{ fontSize: 13 }}>~90 GET endpoints</span>
        <span className="mono" style={{ fontSize: 13 }}>3 data stores + cache</span>
        <span className="mono" style={{ fontSize: 13 }}>5 async workers</span>
        <span className="mono" style={{ fontSize: 13 }}>Android companion app</span>
      </Reveal>
    </div>
  );
}
