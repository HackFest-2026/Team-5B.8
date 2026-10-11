import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Head } from '../ui.jsx';
import { BrandIcon } from '../brand-icons.jsx';

/*
 * Architecture 2 — one request through the cloud. Stepped.
 * price-fn hands the job to the DevNexus engine; DynamoDB feeds the engine the
 * rules + signals; the engine returns the computed price to price-fn (a second
 * line); then the price flows back out to the shopper. No cache (we don't run one).
 */
const POS = {
  user:    { x: 6,  y: 50, glyph: '🧑', label: 'User',            sub: 'website / app' },
  backend: { x: 19, y: 50, glyph: '🏢', label: 'Company backend', sub: 'their server' },
  gateway: { x: 33, y: 50, brand: 'ApiGateway', label: 'API Gateway', sub: 'GET · throttle' },
  price:   { x: 49, y: 22, brand: 'Lambda', label: 'price-fn', sub: 'pricing' },
  event:   { x: 49, y: 50, brand: 'Lambda', label: 'event-fn', sub: 'signals' },
  ai:      { x: 49, y: 78, brand: 'Lambda', label: 'AI-fn',    sub: 'agent' },
  engine:  { x: 69, y: 22, glyph: '⚙',   label: 'DevNexus Engine', sub: 'rules → guardrails' },
  dynamo:  { x: 89, y: 22, brand: 'DynamoDB', label: 'DynamoDB', sub: 'rules + signals' },
  s3:      { x: 69, y: 50, brand: 'S3',    label: 'S3',        sub: 'files' },
  sqs:     { x: 69, y: 78, brand: 'SQS',   label: 'SQS',       sub: 'absorb spikes' },
  workers: { x: 89, y: 78, brand: 'Python', label: 'Workers',  sub: 'store · roll-up' },
};
const NODE_MIN = { user: 1, backend: 2, gateway: 3, price: 4, event: 4, ai: 4, engine: 5, dynamo: 5, s3: 5, sqs: 5, workers: 5 };
/* single-line edges inside the platform */
const EDGES = [
  ['gateway', 'event', 4, 1], ['gateway', 'ai', 4, 1],
  ['dynamo', 'engine', 5, 1],                                  // DynamoDB feeds the engine
  ['event', 's3', 5, 0], ['event', 'sqs', 5, 1], ['sqs', 'workers', 5, 1], ['workers', 'dynamo', 5, 0],
];
/* paired return journey: request line (in) + price line (back, at the end) */
const PAIRS = [['user', 'backend', 2], ['backend', 'gateway', 3], ['gateway', 'price', 4]];
const CAPTION = {
  0: 'A request’s full journey through the cloud — press → to follow it.',
  1: 'A shopper opens the company’s website or app.',
  2: 'The app calls the company’s own backend.',
  3: 'The backend asks DevNexus for a price — in through one API Gateway.',
  4: 'The gateway routes to the right Lambda: price, event, or the AI agent.',
  5: 'price-fn hands the job to the DevNexus engine, and DynamoDB feeds it the rules + signals. (Events queue in SQS → workers; files go to S3.)',
  6: 'The engine applies the rules and guardrails, then returns the computed price to price-fn.',
  7: 'The price flows straight back out — gateway, backend, shopper.',
};

/* offset a straight segment perpendicular by `d` (in 0–100 units, rough) */
function offset(a, b, d) {
  const A = POS[a], B = POS[b];
  const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * d, ny = (dx / len) * d;
  return { ax: A.x + nx, ay: A.y + ny, bx: B.x + nx, by: B.y + ny };
}

export default function ArchCloud({ step }) {
  const on = (id) => step >= NODE_MIN[id];
  const line = (a, b) => `M ${POS[a].x} ${POS[a].y} L ${POS[b].x} ${POS[b].y}`;
  const pe_in = offset('price', 'engine', -1.7);   // price-fn → engine (request)
  const pe_bk = offset('engine', 'price', -1.7);    // engine → price-fn (price back)

  return (
    <div className="col" style={{ gap: 8 }}>
      <Head no="07" eyebrow="How the whole system fits together"
        title={<>High-level <span className="hl">system design.</span></>} sm
        right={<span className="pill">{step}/7</span>} />

      <div className="grid-bg" style={{ position: 'relative', height: 'min(64vh, 500px)' }}>
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: step >= 3 ? 1 : 0.2 }} transition={{ duration: 0.4 }}
          style={{ position: 'absolute', left: '30%', right: '1.5%', top: '2%', bottom: '2%', border: '1.5px dashed var(--line-2)', borderRadius: 22 }}>
          <span className="mono" style={{ position: 'absolute', top: -11, left: 20, background: 'var(--paper)', padding: '0 10px', fontSize: 12, fontWeight: 700, letterSpacing: '.14em', color: 'var(--accent-ink)' }}>DEVNEXUS</span>
        </motion.div>

        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
          {/* single-line edges */}
          {EDGES.map(([a, b, min, flow], n) => (
            <path key={'e' + n} d={line(a, b)} className={`fline ${step >= min ? (flow ? 'flow' : 'on') : ''}`} />
          ))}
          {/* price-fn ↔ engine: request in (step 5), computed price back (step 6) */}
          <path d={`M ${pe_in.ax} ${pe_in.ay} L ${pe_in.bx} ${pe_in.by}`} className={`fline ${step >= 5 ? 'flow' : ''}`} />
          {step >= 6 && <path d={`M ${pe_bk.ax} ${pe_bk.ay} L ${pe_bk.bx} ${pe_bk.by}`} className="fline flow good" />}
          {/* paired return journey */}
          {PAIRS.map(([a, b, min], n) => {
            const inO = offset(a, b, -1.7);
            const bk = offset(b, a, -1.7);
            return (
              <g key={'p' + n}>
                <path d={`M ${inO.ax} ${inO.ay} L ${inO.bx} ${inO.by}`} className={`fline ${step >= min ? 'flow' : ''}`} />
                {step >= 7 && <path d={`M ${bk.ax} ${bk.ay} L ${bk.bx} ${bk.by}`} className="fline flow good" />}
              </g>
            );
          })}
        </svg>

        {Object.entries(POS).map(([id, p]) => (
          <div key={id} className={`fnode ${on(id) ? 'on' : ''} ${id === 'engine' && step >= 5 ? 'pulse' : ''}`} style={{ left: `${p.x}%`, top: `${p.y}%`, zIndex: 2 }}>
            <div className="chip" style={id === 'engine' ? { background: 'var(--ink-grad)', color: '#fff', borderColor: 'transparent' } : undefined}>
              {p.brand ? <BrandIcon name={p.brand} size={30} /> : <span style={{ fontSize: 26 }}>{p.glyph}</span>}
            </div>
            <div className="lab">{p.label}</div>
            {p.sub && <div className="sub">{p.sub}</div>}
          </div>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.p key={step} className="muted" style={{ fontSize: 15, textAlign: 'center', maxWidth: '82ch', margin: '0 auto' }}
          initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
          {CAPTION[step]}
        </motion.p>
      </AnimatePresence>
    </div>
  );
}
