/**
 * DevNexus simulation backend — one Cloudflare Worker per demo site.
 *
 * It does two jobs:
 *   1. Serves the static admin site from ./public (via the ASSETS binding).
 *   2. Proxies a small, safe set of /api/* calls to the REAL DevNexus backend,
 *      holding the account credentials and the project API key server-side so
 *      they never reach the browser.
 *
 * Everything it does is real: prices come from the live pricing engine, signal
 * writes hit the live context, decisions are recorded in DevNexus. The browser
 * drives the simulation loop and the Reset (replaying reverse operations from a
 * baseline snapshot), so this Worker stays stateless and cheap.
 *
 * Config (wrangler.toml [vars]): API_BASE, PROJECT_ID.
 * Secrets (wrangler secret put):  EMAIL, PASSWORD.
 */

let _token = null;        // cached session token for this isolate
let _tokenAt = 0;
let _apiKey = null;       // cached project api key
const TOKEN_TTL = 20 * 60 * 1000;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
      'cache-control': 'no-store',
    },
  });

async function dxGet(env, path, params = {}, { auth = true } = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    q.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  if (auth) q.set('token', await token(env));
  const url = `${env.API_BASE}${path}?${q.toString()}`;
  const res = await fetch(url, { headers: { 'cache-control': 'no-store' } });
  const body = await res.json().catch(() => ({ ok: false, error: 'bad json' }));
  if (body && body.ok === false) {
    const msg = (body.error && body.error.message) || body.error || 'request failed';
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.status = res.status;
    err.code = body.error && body.error.code;
    throw err;
  }
  return body;
}

async function token(env) {
  const now = Date.now();
  if (_token && now - _tokenAt < TOKEN_TTL) return _token;
  const r = await dxGet(env, '/auth/login',
    { email: env.EMAIL, password: env.PASSWORD }, { auth: false });
  _token = r.token;
  _tokenAt = now;
  return _token;
}

async function apiKey(env) {
  if (_apiKey) return _apiKey;
  const g = await dxGet(env, '/projects/get', { project_id: env.PROJECT_ID });
  _apiKey = g.api_key;
  return _apiKey;
}

/** External price call (api-key auth) — request-scope signals are bare params. */
async function priceItem(env, itemId, requestSignals = {}) {
  const key = await apiKey(env);
  const q = new URLSearchParams({ item_id: itemId });
  for (const [k, v] of Object.entries(requestSignals)) {
    if (v === undefined || v === null || v === '') continue;
    q.set(k, v === true ? 'True' : v === false ? 'False' : String(v));
  }
  const url = `${env.API_BASE}/v1/p/${key}/price?${q.toString()}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => ({ ok: false }));
  return body.price || body;
}

/** External global-context write — global fields need the signal_ prefix. */
async function setGlobal(env, signals = {}) {
  const key = await apiKey(env);
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(signals)) {
    if (v === undefined || v === null || v === '') continue;
    // The engine compares booleans against Python's str(True)='True'.
    const sv = v === true ? 'True' : v === false ? 'False' : String(v);
    q.set(`signal_${k}`, sv);
  }
  const url = `${env.API_BASE}/v1/g/${key}/context?${q.toString()}`;
  const res = await fetch(url);
  return res.json().catch(() => ({ ok: false }));
}

async function readBody(request) {
  try { return await request.json(); } catch { return {}; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return json({ ok: true });
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);

    try {
      // ── bootstrap: everything the admin screen needs to render ──────────
      if (path === '/api/bootstrap') {
        const [g, items, rules] = await Promise.all([
          dxGet(env, '/projects/get', { project_id: env.PROJECT_ID }),
          dxGet(env, '/items/list', { project_id: env.PROJECT_ID }),
          dxGet(env, '/rules/list', { project_id: env.PROJECT_ID }),
        ]);
        return json({
          ok: true,
          project: g.project || {},
          currency: (g.project && g.project.currency) || 'INR',
          schema: g.schema || {},
          guardrails: g.guardrails || {},
          items: items.items || [],
          rules: rules.rules || [],
        });
      }

      // ── price one item under given request signals ──────────────────────
      if (path === '/api/price') {
        const { item_id, request: req = {} } = await readBody(request);
        return json({ ok: true, price: await priceItem(env, item_id, req) });
      }

      // ── price all items (one call per item, in parallel) ────────────────
      if (path === '/api/price-all') {
        const { item_ids = [], request: req = {} } = await readBody(request);
        const prices = await Promise.all(item_ids.map((id) => priceItem(env, id, req)));
        return json({ ok: true, prices });
      }

      // ── set global signals (surge, traffic, repo rate…) ─────────────────
      if (path === '/api/context') {
        const { signals = {} } = await readBody(request);
        return json({ ok: true, result: await setGlobal(env, signals) });
      }

      // ── set one item's item-scope signals (session endpoint) ────────────
      if (path === '/api/item-signals') {
        const { item_id, signals = {} } = await readBody(request);
        await dxGet(env, '/items/update',
          { project_id: env.PROJECT_ID, item_id, signals });
        return json({ ok: true });
      }

      // ── CRUD: create / update / delete a product ────────────────────────
      if (path === '/api/item/create') {
        const b = await readBody(request);
        const r = await dxGet(env, '/items/create', {
          project_id: env.PROJECT_ID, item_id: b.item_id, name: b.name,
          base_price: b.base_price, cost: b.cost,
          attributes: b.attributes, signals: b.signals, overwrite: true,
        });
        return json({ ok: true, result: r });
      }
      if (path === '/api/item/update') {
        const b = await readBody(request);
        await dxGet(env, '/items/update', {
          project_id: env.PROJECT_ID, item_id: b.item_id,
          name: b.name, base_price: b.base_price, cost: b.cost,
          attributes: b.attributes, signals: b.signals,
        });
        return json({ ok: true });
      }
      if (path === '/api/item/delete') {
        const b = await readBody(request);
        await dxGet(env, '/items/delete', { project_id: env.PROJECT_ID, item_id: b.item_id });
        return json({ ok: true });
      }

      // ── FULL data wipe: clears decisions, analytics, alerts, audit, signals
      //    on DevNexus (keeps schema/items/rules/strategy). Deletes sim-added
      //    items and restores baseline prices the browser passes in. ─────────
      if (path === '/api/reset') {
        const b = await readBody(request);
        for (const id of (b.deleteItems || [])) {
          try { await dxGet(env, '/items/delete', { project_id: env.PROJECT_ID, item_id: id }); } catch {}
        }
        for (const it of (b.restore || [])) {
          try { await dxGet(env, '/items/update', { project_id: env.PROJECT_ID, item_id: it.item_id, base_price: it.base_price, signals: it.signals }); } catch {}
        }
        const r = await dxGet(env, '/projects/reset-data', { project_id: env.PROJECT_ID });
        return json({ ok: true, cleared: r.cleared || r });
      }

      // ── real project KPIs (match the DevNexus console) ─────────────────
      if (path === '/api/kpis') {
        const r = await dxGet(env, '/analytics/overview', { project_id: env.PROJECT_ID, range: '24h' });
        const k = r.kpis || {};
        const val = (x) => (x && typeof x === 'object') ? (x.value ?? 0) : (x ?? 0);
        return json({ ok: true, decisions: val(k.decisions), price_changes: val(k.price_changes) });
      }

      // ── raise a REAL decision (approval + audit + push to phone) ────────
      if (path === '/api/raise-decision') {
        const b = await readBody(request);
        const r = await dxGet(env, '/approvals/raise',
            { project_id: env.PROJECT_ID, reason: b.reason || '' });
        return json({ ok: true, approval_id: r.approval_id, pushed: r.pushed || 0 });
      }

      // ── any pending decision (mirrors what the phone sees) ──────────────
      if (path === '/api/pending') {
        const r = await dxGet(env, '/approvals/pending', { project_id: env.PROJECT_ID });
        return json({ ok: true, pending: r.approvals || r.pending || [] });
      }

      return json({ ok: false, error: 'unknown route' }, 404);
    } catch (e) {
      return json({ ok: false, error: String(e.message || e), code: e.code || null }, e.status || 500);
    }
  },
};
