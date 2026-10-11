import React from 'react';
import { Head, Reveal, Stagger } from '../ui.jsx';

const PAIN = [
  { big: 'Every industry prices differently', s: 'A hotel thinks in occupancy. A bank thinks in risk. A store thinks in stock. The logic never looks the same twice.' },
  { big: 'So everyone rebuilds it from scratch', s: 'Pricing logic gets hard-coded deep inside each app. Changing a price means a developer, a deploy and a risk.' },
  { big: 'And business teams are locked out', s: 'The people who understand the market can’t touch the prices without filing a ticket and waiting for engineering.' },
];

export default function Problem() {
  return (
    <div className="col">
      <Head no="02" eyebrow="The problem"
        title={<>Prices change every minute.<br /><span className="hl">The software behind them doesn’t.</span></>} />

      <Stagger delay={0.25} gap={0.12} className="row wrap" style={{ gap: 18 }}>
        {PAIN.map((p, n) => (
          <div key={n} className="tile grow" style={{ minWidth: 260, flexBasis: 280 }}>
            <div className="mono" style={{ fontSize: 13, color: 'var(--accent-ink)', marginBottom: 12, fontWeight: 600 }}>0{n + 1}</div>
            <h3 style={{ fontSize: 'clamp(18px,1.6vw,24px)', lineHeight: 1.12, marginBottom: 10 }}>{p.big}</h3>
            <p>{p.s}</p>
          </div>
        ))}
      </Stagger>

      <Reveal delay={0.7} className="mt-l">
        <div className="card" style={{ padding: 'clamp(18px,1.8vw,26px) clamp(22px,2.2vw,32px)', borderLeft: '4px solid var(--accent)' }}>
          <span className="mono" style={{ fontSize: 12, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--accent-ink)' }}>The question we set out to answer</span>
          <p style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 'clamp(20px,2.1vw,34px)', letterSpacing: '-.02em', lineHeight: 1.1, marginTop: 10 }}>
            Can one engine price <span className="hl">anything</span> — without hard-coding a single industry?
          </p>
        </div>
      </Reveal>
    </div>
  );
}
