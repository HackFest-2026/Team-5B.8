#!/usr/bin/env node
/**
 * DevNexus — model × key matrix probe.
 *
 * Gemini model availability varies PER KEY (account age, allowlists) and model
 * health varies minute to minute (503 overload). So we don't guess a model —
 * we measure which (model, key) pairs actually answer, and how fast.
 *
 * Writes .secrets/gemini-model-matrix.json for the key pool to consume.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const TIMEOUT_MS = 30_000;

// Fast-tier candidates, newest first. We want the best model that is
// actually reachable, not the newest one on the marketing page.
const CANDIDATES = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-flash-latest',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
];

const mask = (k) => `${k.slice(0, 12)}…${k.slice(-6)}`;
const clean = (s) => s.trim().replace(/[.\s]+$/, '');

async function gen(model, key) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}/models/${model}:generateContent`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Reply with exactly: ok' }] }],
        generationConfig: {
          maxOutputTokens: 8, temperature: 0,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });
    const ms = Math.round(performance.now() - t0);
    const body = await res.json().catch(() => null);
    if (res.ok) {
      const txt = body?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
      return { ok: true, ms, txt };
    }
    return { ok: false, ms, status: res.status, msg: (body?.error?.message ?? '').slice(0, 70) };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t0), status: 'TIMEOUT', msg: String(e.message ?? e).slice(0, 40) };
  } finally { clearTimeout(timer); }
}

async function pool(items, limit, worker) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await worker(items[n], n); }
  }));
  return out;
}

const keys = [...new Set((await readFile(join(ROOT, '.secrets/gemini-keys.txt'), 'utf8'))
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map(clean))];

// Phase 1 — narrow the model list using 3 sample keys (cheap).
const sample = [keys[0], keys[Math.floor(keys.length / 2)], keys.at(-1)];
console.log(`\n🔬 Phase 1 — probing ${CANDIDATES.length} models with 3 sample keys\n`);

const viable = [];
for (const model of CANDIDATES) {
  const rs = await pool(sample, 3, (k) => gen(model, k));
  const okN = rs.filter((r) => r.ok).length;
  const lat = rs.filter((r) => r.ok).map((r) => r.ms);
  const avg = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null;
  const why = rs.find((r) => !r.ok);
  console.log(
    `${okN === 3 ? '✅' : okN ? '🟡' : '❌'} ${model.padEnd(26)} ${okN}/3` +
    (avg ? `  avg ${avg}ms` : '') +
    (why ? `   [${why.status}] ${why.msg}` : ''),
  );
  if (okN) viable.push({ model, okN, avg });
}

if (!viable.length) { console.log('\n❌ no model reachable right now.'); process.exit(1); }

// Prefer fully-available, then fastest.
viable.sort((a, b) => (b.okN - a.okN) || (a.avg - b.avg));
const best = viable[0].model;
console.log(`\n🏆 chosen model: ${best}  (${viable[0].okN}/3 keys, avg ${viable[0].avg}ms)`);

// Phase 2 — full pool against the chosen model.
console.log(`\n🔬 Phase 2 — all ${keys.length} keys against ${best}\n`);
const rs = await pool(keys, 5, (k) => gen(best, k));

const healthy = [];
rs.forEach((r, n) => {
  if (r.ok) healthy.push(keys[n]);
  console.log(`${r.ok ? '✅' : '❌'} ${String(n + 1).padStart(2)}. ${mask(keys[n])}  ` +
    (r.ok ? `${String(r.ms).padStart(5)}ms  → "${r.txt}"` : `[${r.status}] ${r.msg}`));
});

const lat = rs.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
const p = (q) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))];

console.log(`\n── summary ──────────────────────────────────`);
console.log(`model       ${best}`);
console.log(`healthy     ${healthy.length}/${keys.length} keys`);
if (lat.length) console.log(`latency     p50 ${p(0.5)}ms · p95 ${p(0.95)}ms · max ${lat.at(-1)}ms`);
console.log(`capacity    ~${healthy.length * 10} req/min @10 RPM/key`);

await writeFile(join(ROOT, '.secrets/gemini-model-matrix.json'), JSON.stringify({
  probed_at: new Date().toISOString(),
  chosen_model: best,
  fallback_models: viable.slice(1).map((v) => v.model),
  healthy_keys: healthy,
  dead_keys: rs.map((r, n) => r.ok ? null : { key: mask(keys[n]), status: r.status, msg: r.msg }).filter(Boolean),
}, null, 2) + '\n');

console.log(`\n💾 wrote .secrets/gemini-model-matrix.json`);
