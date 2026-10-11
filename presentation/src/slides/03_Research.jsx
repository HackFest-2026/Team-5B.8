import React from 'react';
import { Head, Reveal, Stagger } from '../ui.jsx';

const ROWS = [
  { d: 'Hotels',        f: 'occupancy · season · lead time' },
  { d: 'Airlines',      f: 'load factor · days to departure · route' },
  { d: 'Lending',       f: 'applicant risk · benchmark rate · tenure' },
  { d: 'Retail',        f: 'inventory · demand · competitor price' },
  { d: 'Ride-hailing',  f: 'demand ÷ supply · zone · rider' },
  { d: 'Energy',        f: 'grid load · time of day · contract' },
];

export default function Research() {
  return (
    <div>
      <Head no="03" eyebrow="What we researched"
        title={<>Different industries.<br /><span className="hl">The same three</span> kinds of input.</>} />

      <div className="row" style={{ gap: 'clamp(28px,4vw,66px)', alignItems: 'center' }}>
        <div className="col gap-m grow" style={{ flexBasis: '44%' }}>
          <Reveal delay={0.2}>
            <p className="lead">
              We studied how real businesses actually decide a price. The words are different
              everywhere — but the shape repeats: a <b>base number</b>, pushed by a few
              <b> signals</b>, held inside <b>safe limits</b>, with someone who needs to know <b>why</b>.
            </p>
          </Reveal>
          <Reveal delay={0.34}>
            <div className="card" style={{ padding: '16px 20px', borderLeft: '4px solid var(--accent)' }}>
              <p style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 'clamp(17px,1.5vw,24px)', letterSpacing: '-.015em', lineHeight: 1.15 }}>
                If every factor is really <span className="hl">item, overall or request</span> — one engine can price them all.
              </p>
            </div>
          </Reveal>
        </div>

        <Stagger delay={0.3} gap={0.08} className="col grow" style={{ gap: 10, flexBasis: '50%' }}>
          {ROWS.map((r) => (
            <div key={r.d} className="row between center card" style={{ padding: '15px 22px' }}>
              <span style={{ fontWeight: 800, fontSize: 'clamp(16px,1.3vw,20px)', letterSpacing: '-.01em' }}>{r.d}</span>
              <span className="mono" style={{ fontSize: 'clamp(11px,.95vw,13px)', color: 'var(--ink-3)' }}>{r.f}</span>
            </div>
          ))}
        </Stagger>
      </div>
    </div>
  );
}
