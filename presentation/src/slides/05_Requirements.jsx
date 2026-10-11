import React from 'react';
import { motion } from 'framer-motion';
import { Head, Reveal, Stagger } from '../ui.jsx';

const FR = [
  ['🧩', 'Model any business', 'Define what you sell and the signals that move its price.'],
  ['✦', 'Configure in plain English', 'The AI agent drafts your schema, rules and test cases.'],
  ['⚖️', 'Rules inside safe limits', 'Build rules; guardrails clamp every result.'],
  ['🧪', 'Test before it goes live', 'Simulate and back-test on the real engine.'],
  ['⚡', 'Serve a price over an API', 'One GET returns a price — with its explanation.'],
  ['🔁', 'Change safely', 'Version, approve and roll back in a click.'],
];
const NFR = [
  ['Fast', 'single-digit-ms pricing'],
  ['Deterministic', 'same inputs → same price'],
  ['Reliable', 'always a price, never an error'],
  ['Scalable', 'serverless; out, and to zero'],
  ['Secure', 'revocable tokens · isolation'],
  ['Explainable', 'every price shows why'],
];
const PROOF = [['~90', 'GET endpoints'], ['9', 'Lambda functions'], ['3', 'stores + cache'], ['5', 'async workers'], ['1', 'Android app']];

export default function Requirements() {
  return (
    <div className="col" style={{ gap: 'clamp(14px,1.6vw,22px)' }}>
      <Head no="05" eyebrow="What it must do — and what we built"
        title={<>Every requirement, <span className="hl">actually delivered.</span></>} sm />

      <div className="row wrap" style={{ gap: 18, alignItems: 'stretch' }}>
        {/* Functional — one big card */}
        <motion.div className="card" style={{ flexBasis: '54%', flexGrow: 1, minWidth: 320, padding: 'clamp(18px,1.8vw,26px)', borderTop: '4px solid var(--accent)' }}
          initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
          <div className="row center gap-s" style={{ marginBottom: 16 }}>
            <span className="pill accent">Functional</span>
            <span className="muted" style={{ fontSize: 13 }}>what the platform does</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            {FR.map(([g, h, s], n) => (
              <motion.div key={h} className="row gap-s" style={{ alignItems: 'flex-start' }}
                initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.2 + n * 0.07 }}>
                <span style={{ fontSize: 19, flex: 'none', color: g === '✦' ? 'var(--accent)' : undefined }}>{g}</span>
                <div className="col" style={{ gap: 1 }}>
                  <b style={{ fontSize: 'clamp(14px,1.1vw,16.5px)' }}>{h}</b>
                  <span className="muted" style={{ fontSize: 'clamp(12px,.92vw,13px)', lineHeight: 1.4 }}>{s}</span>
                </div>
              </motion.div>
            ))}
          </div>
        </motion.div>

        {/* Non-functional — nice tiles */}
        <div className="col grow" style={{ flexBasis: '40%', minWidth: 280, gap: 12 }}>
          <Reveal delay={0.2}><span className="pill ink">Non-functional</span></Reveal>
          <Stagger delay={0.3} gap={0.06} className="row wrap" style={{ gap: 10 }}>
            {NFR.map(([k, v]) => (
              <div key={k} className="tile" style={{ flex: '1 1 130px', minWidth: 128, padding: 14 }}>
                <b style={{ fontSize: 15.5 }}>{k}</b>
                <p style={{ marginTop: 3, fontSize: 12.5 }}>{v}</p>
              </div>
            ))}
          </Stagger>
        </div>
      </div>

      <Reveal delay={0.55}>
        <div className="card row wrap between" style={{ padding: 'clamp(13px,1.3vw,18px) clamp(18px,2vw,30px)', gap: 18, alignItems: 'center' }}>
          <span className="mono" style={{ fontSize: 12, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--accent-ink)' }}>Delivered, not promised</span>
          {PROOF.map(([v, l]) => (
            <div key={l} className="col" style={{ gap: 0 }}>
              <span className="statnum" style={{ fontSize: 'clamp(22px,2.2vw,34px)' }}>{v}</span>
              <span className="muted" style={{ fontSize: 12 }}>{l}</span>
            </div>
          ))}
        </div>
      </Reveal>
    </div>
  );
}
