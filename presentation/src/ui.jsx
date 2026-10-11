import React from 'react';
import { motion } from 'framer-motion';

/* Consistent, prominent slide header so every slide clearly names itself. */
export function Head({ no, eyebrow, title, right, plain = false, sm = false }) {
  return (
    <div className="head">
      <motion.div
        className={`eyebrow ${plain ? 'plain' : ''}`}
        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}
      >
        {no && <span className="no">{no}</span>}
        {eyebrow}
      </motion.div>
      <div className="row-title">
        <motion.h2
          className={`title ${sm ? 'title-sm' : ''}`}
          initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.08, ease: [0.22, 0.61, 0.36, 1] }}
        >{title}</motion.h2>
        {right && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }}>
            {right}
          </motion.div>
        )}
      </div>
    </div>
  );
}

export function Stagger({ children, delay = 0.12, gap = 0.08, className = '', style }) {
  const arr = React.Children.toArray(children);
  return (
    <div className={className} style={style}>
      {arr.map((c, n) => (
        <motion.div key={n}
          initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: delay + n * gap, ease: [0.22, 0.61, 0.36, 1] }}
        >{c}</motion.div>
      ))}
    </div>
  );
}

export function Reveal({ children, delay = 0, y = 16, className = '', style }) {
  return (
    <motion.div className={className} style={style}
      initial={{ opacity: 0, y }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, delay, ease: [0.22, 0.61, 0.36, 1] }}
    >{children}</motion.div>
  );
}

/* legacy helper kept for slides still using it */
export function Kicker({ n, children }) {
  return <div className="eyebrow">{n && <span className="no">{n}</span>}{children}</div>;
}

export function Stat({ value, unit, label, delay = 0 }) {
  return (
    <Reveal delay={delay} className="col" style={{ gap: 6 }}>
      <div className="statnum">{value}{unit && <span className="u">{unit}</span>}</div>
      <div className="muted" style={{ fontSize: 14, lineHeight: 1.35 }}>{label}</div>
    </Reveal>
  );
}
