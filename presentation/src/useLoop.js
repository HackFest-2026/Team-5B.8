import { useEffect, useState } from 'react';

/* Cycles phase 0,1,…,steps repeatedly, every `ms`. Used by the auto-looping
 * architecture animations so stages activate, then reset, then repeat. */
export function useLoop(steps, ms = 850) {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setPhase((p) => (p + 1) % (steps + 1)), ms);
    return () => clearInterval(id);
  }, [steps, ms]);
  return phase;
}
