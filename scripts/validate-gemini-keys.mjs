#!/usr/bin/env node
/**
 * DevNexus — Gemini key pool validator.
 *
 * Reads .secrets/gemini-keys.txt, probes every key against the NATIVE Gemini
 * endpoint, and writes the healthy subset to .secrets/gemini-keys.valid.json.
 *
 * Two probes per key, because AQ. keys fail in two different ways:
 *   1. GET  /v1beta/models            → auth works? (no generation quota used)
 *   2. POST /v1beta/{model}:generate  → quota actually attached? (some AQ keys
 *                                        are provisioned with zero quota)
 *
 * Usage:  node scripts/validate-gemini-keys.mjs [--model gemini-2.5-flash]
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEYS_FILE = join(ROOT, '.secrets', 'gemini-keys.txt');
const OUT_FILE = join(ROOT, '.secrets', 'gemini-keys.valid.json');
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

const argModel = process.argv.indexOf('--model');
const MODEL = argModel > -1 ? process.argv[argModel + 1] : 'gemini-2.5-flash';
const CONCURRENCY = 6;
const TIMEOUT_MS = 20_000;

const mask = (k) => `${k.slice(0, 12)}…${k.slice(-6)}`;

/** Strip paste artifacts: trailing dots, whitespace, stray wrapping. */
function clean(raw) {
  return raw.trim().replace(/[.\s]+$/, '');
}

async function req(path, key, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: {
        'x-goog-api-key': key,       // the documented header for AQ. Auth keys
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const ms = Math.round(performance.now() - t0);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON error page */ }
    return { ok: res.ok, status: res.status, ms, json, text };
  } finally {
    clearTimeout(timer);
  }
}

async function probe(key) {
  // ── Probe 1: auth + model visibility ────────────────────────────────
  const list = await req('/models?pageSize=200', key);
  if (!list.ok) {
    const msg = list.json?.error?.message ?? list.text.slice(0, 160);
    return { key, state: 'AUTH_FAIL', status: list.status, detail: msg, ms: list.ms };
  }

  const models = (list.json?.models ?? [])
    .map((m) => m.name?.replace('models/', ''))
    .filter(Boolean);

  // ── Probe 2: does it actually have generation quota? ─────────────────
  const gen = await req(`/models/${MODEL}:generateContent`, key, {
    method: 'POST',
    body: JSON.stringify({
      contents: [{ parts: [{ text: 'Reply with the single word: ok' }] }],
      generationConfig: {
        maxOutputTokens: 8,
        temperature: 0,
        thinkingConfig: { thinkingBudget: 0 }, // latency: no thinking tokens
      },
    }),
  });

  if (gen.ok) {
    const out = gen.json?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
    return {
      key, state: 'OK', status: 200, ms: gen.ms,
      modelCount: models.length, sample: out,
      hasFlash: models.some((m) => m.includes('flash')),
    };
  }

  const err = gen.json?.error ?? {};
  const state =
    gen.status === 429 ? 'RATE_LIMITED'
    : /quota/i.test(err.message ?? '') ? 'NO_QUOTA'
    : gen.status === 404 ? 'MODEL_UNAVAILABLE'
    : 'GEN_FAIL';

  return {
    key, state, status: gen.status, ms: gen.ms,
    detail: (err.message ?? gen.text).slice(0, 160),
    modelCount: models.length,
  };
}

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try { out[idx] = await worker(items[idx]); }
        catch (e) { out[idx] = { key: items[idx], state: 'ERROR', detail: String(e.message ?? e) }; }
      }
    }),
  );
  return out;
}

const ICON = {
  OK: '✅', AUTH_FAIL: '❌', NO_QUOTA: '🚫', RATE_LIMITED: '⏳',
  MODEL_UNAVAILABLE: '🔍', GEN_FAIL: '⚠️ ', ERROR: '💥',
};

const raw = await readFile(KEYS_FILE, 'utf8');
const keys = [...new Set(
  raw.split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map(clean),
)];

console.log(`\n🔑 DevNexus Gemini key pool validator`);
console.log(`   keys: ${keys.length}   model: ${MODEL}   concurrency: ${CONCURRENCY}\n`);

const results = await pool(keys, CONCURRENCY, probe);

for (const [n, r] of results.entries()) {
  const tail = r.state === 'OK'
    ? `${String(r.ms).padStart(5)}ms  models:${r.modelCount}  → "${r.sample}"`
    : `${r.status ?? '-'}  ${r.detail ?? ''}`;
  console.log(`${ICON[r.state] ?? '?'} ${String(n + 1).padStart(2)}. ${mask(r.key)}  ${r.state.padEnd(18)} ${tail}`);
}

const healthy = results.filter((r) => r.state === 'OK');
const retryable = results.filter((r) => r.state === 'RATE_LIMITED');

console.log(`\n── summary ──────────────────────────────────`);
for (const [state, icon] of Object.entries(ICON)) {
  const n = results.filter((r) => r.state === state).length;
  if (n) console.log(`${icon} ${state.padEnd(18)} ${n}`);
}

if (healthy.length) {
  const lat = healthy.map((r) => r.ms).sort((a, b) => a - b);
  const p = (q) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))];
  console.log(`\n⚡ latency over healthy keys: p50 ${p(0.5)}ms · p95 ${p(0.95)}ms · max ${lat.at(-1)}ms`);
  console.log(`📈 pool capacity @10 RPM/key ≈ ${healthy.length * 10} req/min (~${(healthy.length * 10 / 60).toFixed(1)}/sec)`);
}

await writeFile(OUT_FILE, JSON.stringify({
  validated_at: new Date().toISOString(),
  model: MODEL,
  healthy: healthy.map((r) => r.key),
  retryable: retryable.map((r) => r.key),
  rejected: results.filter((r) => !['OK', 'RATE_LIMITED'].includes(r.state))
    .map((r) => ({ key: mask(r.key), state: r.state, detail: r.detail })),
}, null, 2) + '\n');

console.log(`\n💾 wrote ${healthy.length} healthy key(s) → .secrets/gemini-keys.valid.json`);
if (retryable.length) console.log(`   (${retryable.length} rate-limited — re-run later, they are probably fine)`);
process.exit(healthy.length ? 0 : 1);
