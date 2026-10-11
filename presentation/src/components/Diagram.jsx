import React, { useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { BrandIcon } from '../brand-icons.jsx';

/*
 * Progressive-activation architecture diagram.
 * The WHOLE diagram is always on screen; nodes/edges start dim and light up as
 * `step` advances. Active edges carry a flowing dot so data looks like it moves.
 *
 * nodes: { id, x, y (percent), brand?|glyph?, label, sub?, on (bool), pulse? }
 * edges: { from, to, on (bool), flow (bool), bend? (px perpendicular offset) }
 */
export default function Diagram({ nodes, edges, height = 460 }) {
  const ref = useRef(null);
  const [size, setSize] = useState({ w: 1000, h: height });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const pos = (id) => {
    const n = nodes.find((x) => x.id === id);
    return { x: (n.x / 100) * size.w, y: (n.y / 100) * size.h };
  };

  const pathFor = (e) => {
    const a = pos(e.from), b = pos(e.to);
    if (!e.bend) return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    return `M ${a.x} ${a.y} Q ${mx + nx * e.bend} ${my + ny * e.bend} ${b.x} ${b.y}`;
  };

  return (
    <div ref={ref} className="diagram grid-bg" style={{ height }}>
      <svg width={size.w} height={size.h} style={{ position: 'absolute', inset: 0, zIndex: 1 }}>
        {edges.map((e, n) => (
          <path key={'e' + n} className={`edge ${e.on ? 'on' : ''}`} d={pathFor(e)} />
        ))}
        {edges.map((e, n) =>
          e.on && e.flow ? (
            <FlowDot key={'f' + n} a={pos(e.from)} b={pos(e.to)} bend={e.bend} />
          ) : null
        )}
      </svg>

      {nodes.map((nd) => (
        <div
          key={nd.id}
          className={`node ${nd.on ? 'on' : ''} ${nd.pulse && nd.on ? 'pulse' : ''}`}
          style={{ left: `${nd.x}%`, top: `${nd.y}%`, zIndex: 2 }}
        >
          <div className="chip" style={nd.big ? { width: 74, height: 74 } : undefined}>
            {nd.brand ? <BrandIcon name={nd.brand} size={nd.big ? 34 : 28} />
              : <span style={{ fontSize: nd.big ? 28 : 22 }}>{nd.glyph}</span>}
          </div>
          <div className="lab">{nd.label}</div>
          {nd.sub && <div className="sub">{nd.sub}</div>}
        </div>
      ))}
    </div>
  );
}

function FlowDot({ a, b, bend }) {
  // simple linear travel; good enough visually even on slightly-bent edges
  return (
    <motion.circle
      className="flowdot" r={4.5}
      initial={{ cx: a.x, cy: a.y, opacity: 0 }}
      animate={{ cx: [a.x, b.x], cy: [a.y, b.y], opacity: [0, 1, 1, 0] }}
      transition={{ duration: 1.3, repeat: Infinity, ease: 'easeInOut' }}
    />
  );
}
