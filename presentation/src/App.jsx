import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

import Title from './slides/01_Title.jsx';
import Problem from './slides/02_Problem.jsx';
import Research from './slides/03_Research.jsx';
import Product from './slides/04_Product.jsx';
import ArchEngine from './slides/06_ArchEngine.jsx';
import EngineWorks from './slides/18_EngineWorks.jsx';
import ArchCloud from './slides/07_ArchCloud.jsx';
import ArchProject from './slides/08_ArchProject.jsx';
import AIArch from './slides/15_AI.jsx';
import Operate from './slides/13_Operate.jsx';
import TechStack from './slides/19_TechStack.jsx';
import KPIs from './slides/11_KPIs.jsx';
import Deliverables from './slides/16_Deliverables.jsx';
import Team from './slides/17_Team.jsx';

const SLIDES = [
  { id: 'title',   label: 'Cover',                  Component: Title,        steps: 0 },
  { id: 'problem', label: 'The problem',            Component: Problem,      steps: 0 },
  { id: 'research',label: 'Research',               Component: Research,     steps: 0 },
  { id: 'product', label: 'The product',            Component: Product,      steps: 0 },
  { id: 'a-engine',label: 'Architecture · engine',  Component: ArchEngine,   steps: 0 },
  { id: 'a-works', label: 'Inside the engine',      Component: EngineWorks,  steps: 5 },
  { id: 'a-cloud', label: 'System design',          Component: ArchCloud,    steps: 7 },
  { id: 'ai',      label: 'The AI layer',           Component: AIArch,       steps: 0 },
  { id: 'operate', label: 'The app',                Component: Operate,      steps: 0 },
  { id: 'tech',    label: 'Tech stack',             Component: TechStack,    steps: 0 },
  { id: 'a-proj',  label: 'Architecture · setup',   Component: ArchProject,  steps: 5 },
  { id: 'kpis',    label: 'KPIs',                   Component: KPIs,         steps: 0 },
  { id: 'deliver', label: 'Deliverables',           Component: Deliverables, steps: 0 },
  { id: 'team',    label: 'Team',                   Component: Team,         steps: 0 },
];

const QS = (() => { try { return new URLSearchParams(location.search); } catch { return new URLSearchParams(); } })();
const START = (() => {
  const n = parseInt(QS.get('slide'), 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(15, n - 1)) : 0;
})();
const START_STEP = (() => { const n = parseInt(QS.get('step'), 10); return Number.isFinite(n) ? n : 0; })();

export default function App() {
  const [i, setI] = useState(START);
  const [step, setStep] = useState(START_STEP);
  const [dir, setDir] = useState(1);
  const slide = SLIDES[i];

  const go = useCallback((ni, ns = 0, d = 1) => { setDir(d); setI(ni); setStep(ns); }, []);

  const next = useCallback(() => {
    if (step < slide.steps) { setDir(1); setStep((s) => s + 1); return; }
    if (i < SLIDES.length - 1) go(i + 1, 0, 1);
  }, [i, step, slide, go]);

  const prev = useCallback(() => {
    if (step > 0) { setDir(-1); setStep((s) => s - 1); return; }
    if (i > 0) go(i - 1, SLIDES[i - 1].steps, -1);
  }, [i, step, go]);

  const toggleFull = () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); prev(); }
      else if (e.key === 'Home') go(0, 0, -1);
      else if (e.key === 'End') go(SLIDES.length - 1, 0, 1);
      else if (e.key.toLowerCase() === 'f') toggleFull();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, prev, go]);

  const variants = useMemo(() => ({
    enter: (d) => ({ opacity: 0, y: d > 0 ? 26 : -26 }),
    center: { opacity: 1, y: 0 },
    exit: (d) => ({ opacity: 0, y: d > 0 ? -20 : 20 }),
  }), []);

  const Comp = slide.Component;

  return (
    <div className="deck">
      <main className="stage">
        <AnimatePresence custom={dir} mode="wait">
          <motion.div key={slide.id} className="slide" custom={dir} variants={variants}
            initial="enter" animate="center" exit="exit"
            transition={{ duration: 0.5, ease: [0.22, 0.61, 0.36, 1] }}>
            <div className="slide-inner"><Comp step={step} total={slide.steps} index={i} /></div>
          </motion.div>
        </AnimatePresence>
      </main>

      <footer className="botbar">
        <div className="rail">
          {SLIDES.map((s, n) => (
            <span key={s.id} className={`seg ${n < i ? 'done' : ''} ${n === i ? 'cur' : ''}`}
              onClick={() => go(n, 0, n > i ? 1 : -1)} title={s.label}><i /></span>
          ))}
        </div>
        {slide.steps > 0
          ? <span className="stephint"><kbd>→</kbd> {step}/{slide.steps}</span>
          : <span className="stephint" style={{ opacity: .55 }}><kbd>→</kbd></span>}
        <span className="counter">{String(i + 1).padStart(2, '0')} / {SLIDES.length}</span>
      </footer>
    </div>
  );
}
