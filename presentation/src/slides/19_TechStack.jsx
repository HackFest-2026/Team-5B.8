import React from 'react';
import { motion } from 'framer-motion';
import { Head } from '../ui.jsx';
import { BrandIcon, BRAND_COLOR } from '../brand-icons.jsx';

/*
 * Tech stack — real brand icons (tinted with each brand's colour) + one clear
 * line on what it does. Honest: cache is in-memory (not Redis); AI is a neutral
 * mark (no vendor logo); backend shown as FastAPI (Python is implied).
 */
const BUILD = [
  { brand: 'FastAPI',  name: 'FastAPI',  desc: 'Our backend — every configure, price and analytics call runs through it.' },
  { brand: 'React',    name: 'React',    desc: 'The web dashboard the business team uses to set everything up.' },
  { brand: 'Flutter',  name: 'Flutter',  desc: 'One codebase for the Android and iOS companion app.' },
  { brand: 'Firebase', name: 'FCM', desc: 'Firebase Cloud Messaging — delivers push straight to the phone.' },
  { glyph: '✦',        name: 'AI agent', desc: 'Turns plain English into draft rules and schema — you approve them.' },
];
const AWS = [
  { brand: 'ApiGateway', name: 'API Gateway', desc: 'The single front door every request comes through.' },
  { brand: 'Lambda',     name: 'Lambda',      desc: 'Runs our code only when called — no servers to keep up.' },
  { brand: 'DynamoDB',   name: 'DynamoDB',    desc: 'Stores projects, rules, signals and every decision.' },
  { brand: 'S3',         name: 'S3',          desc: 'Holds uploaded catalogue and history files.' },
  { brand: 'SQS',        name: 'SQS',         desc: 'Queues events so traffic spikes never overload us.' },
  { brand: 'CloudWatch', name: 'CloudWatch',  desc: 'Watches speed and errors, and alerts us when something slips.' },
];

function Tile({ it, delay }) {
  const color = it.brand ? BRAND_COLOR[it.brand] : 'var(--accent)';
  return (
    <motion.div className="tile row" style={{ gap: 14, alignItems: 'flex-start', padding: 'clamp(13px,1.3vw,18px)' }}
      initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay, duration: 0.45, ease: [0.22, 0.61, 0.36, 1] }}>
      <span style={{ width: 46, height: 46, borderRadius: 13, flex: 'none', display: 'grid', placeItems: 'center',
        background: it.brand ? `${color}14` : 'var(--accent-soft)', border: `1px solid ${it.brand ? `${color}33` : 'var(--accent-soft)'}` }}>
        {it.brand ? <BrandIcon name={it.brand} size={26} /> : <span style={{ fontSize: 22, color: 'var(--accent)' }}>{it.glyph}</span>}
      </span>
      <div className="col" style={{ gap: 3, minWidth: 0 }}>
        <b style={{ fontSize: 'clamp(15px,1.2vw,18px)', letterSpacing: '-.01em' }}>{it.name}</b>
        <span className="muted" style={{ fontSize: 'clamp(12.5px,1vw,14px)', lineHeight: 1.4 }}>{it.desc}</span>
      </div>
    </motion.div>
  );
}

function Section({ icon, title, items, cols, start }) {
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row center gap-s">
        <span style={{ fontSize: 19 }}>{icon}</span>
        <b style={{ fontFamily: 'var(--display)', fontWeight: 800, fontSize: 'clamp(16px,1.4vw,21px)', letterSpacing: '-.02em' }}>{title}</b>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: 14 }}>
        {items.map((it, i) => <Tile key={it.name} it={it} delay={start + i * 0.06} />)}
      </div>
    </div>
  );
}

export default function TechStack() {
  return (
    <div className="col" style={{ gap: 'clamp(18px,2.4vw,30px)' }}>
      <Head no="10" eyebrow="What we built it with"
        title={<>The stack — <span className="hl">and why.</span></>} sm />

      <Section icon="🧩" title="Build & run" items={BUILD} cols={5} start={0.15} />
      <Section icon="☁️" title="AWS — serverless cloud" items={AWS} cols={3} start={0.45} />

      <motion.div className="row center" style={{ justifyContent: 'center', marginTop: 2 }}
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.9 }}>
        <span className="muted" style={{ fontSize: 14, textAlign: 'center' }}>
          Serverless end-to-end — nothing to keep running, nothing to scale by hand.
        </span>
      </motion.div>
    </div>
  );
}
