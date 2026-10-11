#!/usr/bin/env node
/**
 * WebSocket probe for the test runner.
 *
 * Python's standard library has no WebSocket client, so the WS-* tests shell
 * out to this. It connects, optionally sends frames, optionally triggers HTTP
 * activity to make the workers publish, collects everything that arrives, and
 * prints one JSON object on stdout.
 *
 *   node ws_probe.mjs '<json-config>'
 *
 * config = {
 *   ws, api, token, project_id, key, item_id,
 *   channels:   [..]        subscribe to these after connect
 *   seconds:    12          how long to listen
 *   send:       [{...}]     raw frames to send after connect
 *   trigger:    "events"|"price"|"both"|"none"
 *   signals:    {k:v}       signal values to push when triggering
 * }
 */

const cfg = JSON.parse(process.argv[2]);
const out = {
  connected: false,
  close_code: null,
  close_reason: "",
  error: null,
  frames: [],
  channels_seen: [],
  frame_count: 0,
  max_events_in_one_frame: 0,
  elapsed_ms: 0,
};

const t0 = Date.now();
const seconds = cfg.seconds ?? 12;

async function trigger() {
  const mode = cfg.trigger ?? "none";
  if (mode === "none") return;
  const sig = cfg.signals ?? {};
  const qs = Object.entries(sig)
    .map(([k, v]) => `signal_${k}=${encodeURIComponent(v)}`)
    .join("&");

  if (mode === "events" || mode === "both") {
    const n = cfg.event_count ?? 4;
    const batch = [];
    for (let i = 0; i < n; i++) {
      batch.push(
        fetch(
          `${cfg.api}/v1/t/${cfg.key}/event?item_id=${cfg.item_id}` +
            `&event_type=signal_update&event_id=wsp-${Date.now()}-${i}-${Math.random()
              .toString(36)
              .slice(2, 8)}` +
            (qs ? `&${qs}` : "")
        ).catch(() => {})
      );
    }
    await Promise.all(batch);
  }
  if (mode === "price" || mode === "both") {
    // Give the feature worker a moment so the decision reflects the signals.
    await new Promise((r) => setTimeout(r, mode === "both" ? 9000 : 500));
    await fetch(`${cfg.api}/v1/p/${cfg.key}/price?item_id=${cfg.item_id}`).catch(() => {});
  }
}

let ws;
try {
  const url =
    `${cfg.ws}?token=${encodeURIComponent(cfg.token)}&project_id=${encodeURIComponent(cfg.project_id)}` +
    (cfg.connect_channels ? `&channels=${cfg.connect_channels}` : "");
  ws = new WebSocket(url);
} catch (e) {
  out.error = String(e.message ?? e);
  console.log(JSON.stringify(out));
  process.exit(0);
}

ws.onopen = async () => {
  out.connected = true;
  for (const frame of cfg.send ?? []) {
    try {
      ws.send(JSON.stringify(frame));
    } catch {}
  }
  if (cfg.channels) {
    try {
      ws.send(JSON.stringify({ action: "subscribe", channels: cfg.channels }));
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 800));
  await trigger();
};

ws.onmessage = (e) => {
  out.frame_count++;
  let parsed = null;
  try {
    parsed = JSON.parse(e.data);
  } catch {
    parsed = { raw: String(e.data).slice(0, 400) };
  }
  if (parsed.channel && !out.channels_seen.includes(parsed.channel)) {
    out.channels_seen.push(parsed.channel);
  }
  const n = parsed?.data?.events?.length ?? 0;
  if (n > out.max_events_in_one_frame) out.max_events_in_one_frame = n;
  // Keep frames small so the JSON stays printable.
  if (out.frames.length < 40) {
    out.frames.push({
      channel: parsed.channel ?? null,
      keys: parsed.data ? Object.keys(parsed.data) : Object.keys(parsed),
      sample: JSON.stringify(parsed.data ?? parsed).slice(0, 320),
    });
  }
};

ws.onerror = (e) => {
  out.error = String(e?.message ?? "websocket error");
};

ws.onclose = (e) => {
  out.close_code = e.code;
  out.close_reason = e.reason || "";
};

setTimeout(() => {
  out.elapsed_ms = Date.now() - t0;
  try {
    ws.close();
  } catch {}
  console.log(JSON.stringify(out));
  process.exit(0);
}, seconds * 1000);
