import React from 'react';
import { motion } from 'framer-motion';
import { Head, Stagger, Reveal } from '../ui.jsx';
import { BrandIcon } from '../brand-icons.jsx';

const FEATURES = [
  ['🔔', 'A notification agent', 'It decides when something is worth interrupting you for — and pushes only that.'],
  ['✅', 'Approve in one tap', 'A clear question, safe options, approved straight from the lock screen.'],
  ['📊', 'Analytics on the go', 'Live prices, decisions and alerts — the whole dashboard in your pocket.'],
];

/* Matches the real Flutter app: dark theme, amber accent, rounded cards. */
function AppPhone() {
  return (
    <div className="appphone">
      <div className="screen" style={{ padding: '14px 13px', display: 'flex', flexDirection: 'column', gap: 11 }}>
        <div className="row between center" style={{ fontFamily: 'var(--mono)', fontSize: 11, color: '#6B6B73' }}>
          <span>11:47 PM</span><span>⌁ ▾ ▰</span>
        </div>
        <div className="row between center">
          <div className="col" style={{ gap: 1 }}>
            <span style={{ fontFamily: 'var(--display)', fontWeight: 800, fontSize: 17 }}>Decisions</span>
            <span style={{ fontSize: 11, color: '#7A7A82' }}>1 needs you</span>
          </div>
          <span style={{ width: 30, height: 30, borderRadius: 9, background: '#1A1A20', display: 'grid', placeItems: 'center', color: '#F6A42B', fontWeight: 800 }}>D</span>
        </div>
        <motion.div style={{ background: '#17171C', border: '1px solid #26262E', borderRadius: 13, padding: '10px 12px', display: 'flex', gap: 10, alignItems: 'center' }}
          initial={{ y: -20, opacity: 0 }} animate={{ y: [-20, 0, 0, 0], opacity: [0, 1, 1, 1] }} transition={{ duration: 3.2, repeat: Infinity, times: [0, 0.1, 0.9, 1] }}>
          <span style={{ width: 24, height: 24, borderRadius: 7, background: '#F6A42B', color: '#141414', display: 'grid', placeItems: 'center', flex: 'none', fontWeight: 800, fontSize: 13 }}>D</span>
          <span style={{ fontSize: 11.5, color: '#C9C9CF' }}>Spike detected — a price decision needs you</span>
        </motion.div>
        <div style={{ background: '#15151A', border: '1px solid #26262E', borderRadius: 15, padding: 14, flex: 1, display: 'flex', flexDirection: 'column', gap: 11 }}>
          <span className="mono app-accent" style={{ fontSize: 10, letterSpacing: '.1em' }}>HOTEL PRICING · CRITICAL</span>
          <div style={{ fontSize: 14.5, fontWeight: 700, lineHeight: 1.35 }}>Demand spiked 60% in an hour. How should we respond?</div>
          <div className="col" style={{ gap: 9, marginTop: 'auto' }}>
            <motion.div style={{ position: 'relative', background: '#F6A42B', color: '#161106', borderRadius: 12, padding: '12px 13px', fontSize: 13, fontWeight: 800 }}
              animate={{ boxShadow: ['0 0 0 0 rgba(246,164,43,.5)', '0 0 0 9px rgba(246,164,43,0)'] }} transition={{ duration: 1.5, repeat: Infinity }}>
              Activate safe mode
              <span style={{ display: 'block', fontSize: 10.5, fontWeight: 600, opacity: .8 }}>recommended</span>
            </motion.div>
            <div style={{ border: '1px solid #2C2C34', borderRadius: 12, padding: '12px 13px', fontSize: 13, color: '#C9C9CF', fontWeight: 600 }}>Keep monitoring</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Operate() {
  return (
    <div>
      <Head no="09" eyebrow="The companion app · Android / iOS"
        title={<>Pricing in your <span className="hl">pocket.</span></>} sm />

      <div className="row" style={{ gap: 'clamp(24px,3.5vw,56px)', alignItems: 'center' }}>
        <div className="col grow" style={{ flexBasis: '58%', gap: 16 }}>
          <Reveal delay={0.12}>
            <div className="card" style={{ padding: '16px 20px', borderLeft: '4px solid var(--accent)' }}>
              <p style={{ fontSize: 'clamp(15px,1.35vw,20px)', lineHeight: 1.5 }}>
                Pricing doesn’t pause when the operator steps away from their desk. When a market
                event needs a human decision, the app <b>reaches the on-call operator directly</b> —
                so critical calls are made in seconds, from anywhere, without opening a console.
              </p>
            </div>
          </Reveal>

          <Stagger delay={0.3} gap={0.1} className="col" style={{ gap: 11 }}>
            {FEATURES.map(([g, h, s]) => (
              <div key={h} className="row gap-m center">
                <span style={{ fontSize: 22, width: 30, flex: 'none' }}>{g}</span>
                <div className="col" style={{ gap: 1 }}>
                  <b style={{ fontSize: 'clamp(15px,1.3vw,19px)' }}>{h}</b>
                  <span className="muted" style={{ fontSize: 'clamp(13px,1vw,14.5px)', lineHeight: 1.45 }}>{s}</span>
                </div>
              </div>
            ))}
          </Stagger>

          <Reveal delay={0.7} className="row center" style={{ gap: 14 }}>
            <span className="pill" style={{ gap: 10, padding: '10px 18px', fontSize: 14 }}><BrandIcon name="Flutter" size={24} /> Flutter</span>
            <span className="pill" style={{ gap: 10, padding: '10px 18px', fontSize: 14 }}><BrandIcon name="Firebase" size={24} /> FCM push</span>
          </Reveal>
        </div>

        <Reveal delay={0.4} className="grow" style={{ flexBasis: '38%', display: 'flex', justifyContent: 'center' }}>
          <AppPhone />
        </Reveal>
      </div>
    </div>
  );
}
