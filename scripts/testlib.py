"""Shared helpers for the DevNexus test runner.

HTTP via urllib so this needs no third-party packages — the runner has to work
on a machine where nothing is installed locally.

The xlsx writer is hand-rolled on zipfile + XML (inline strings) for the same
reason. It only needs to produce what Excel and Numbers will open, not the full
OOXML surface.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass, field

TIMEOUT = 45


# ════════════════════════════════════════════════════════════════════════
#  HTTP
# ════════════════════════════════════════════════════════════════════════

@dataclass
class Response:
    status: int
    body: dict
    ms: float
    raw: str = ""

    @property
    def ok(self) -> bool:
        return self.status == 200 and self.body.get("ok") is True

    def get(self, path: str, default=None):
        """Dotted lookup: resp.get('price.drivers.0.impact')."""
        cur = self.body
        for key in path.split("."):
            if isinstance(cur, list):
                try:
                    cur = cur[int(key)]
                except (ValueError, IndexError):
                    return default
            elif isinstance(cur, dict):
                if key not in cur:
                    return default
                cur = cur[key]
            else:
                return default
        return default if cur is None else cur

    @property
    def error(self) -> str:
        e = self.body.get("error")
        if isinstance(e, dict):
            return f"{e.get('code')}: {e.get('message')}"
        return self.raw[:200] if not self.ok else ""


# ── connection pooling ──────────────────────────────────────────────────
#
# A fresh urlopen() per call means a fresh DNS lookup and a fresh TLS handshake
# every time. Across a few thousand calls macOS's mDNSResponder gives up and
# starts returning "nodename nor servname provided", which looks exactly like
# an API outage but is purely local. One kept-alive connection per host fixes
# it and removes ~100-200ms of handshake from every call.

import http.client  # noqa: E402
import threading  # noqa: E402

# One connection PER THREAD, not per process. http.client.HTTPSConnection is
# not safe to share: two threads interleaving request() and getresponse() on
# the same socket read each other's bytes, which shows up as impossible
# responses rather than a clean error. Thread-local keeps the keep-alive win
# while making parallel() safe.
_local = threading.local()
_err_lock = threading.Lock()
_transport_errors = 0


def _conn(host: str) -> http.client.HTTPSConnection:
    conns = getattr(_local, "conns", None)
    if conns is None:
        conns = _local.conns = {}
    c = conns.get(host)
    if c is None:
        c = http.client.HTTPSConnection(host, timeout=TIMEOUT)
        conns[host] = c
    return c


def _drop(host: str) -> None:
    conns = getattr(_local, "conns", None) or {}
    c = conns.pop(host, None)
    if c is not None:
        try:
            c.close()
        except Exception:  # noqa: BLE001
            pass


def transport_error_count() -> int:
    return _transport_errors


def call(base: str, path: str, *, retries: int = 3, **params) -> Response:
    """GET with query params over a pooled keep-alive connection.

    Never raises. Transport failures are retried with backoff and the
    connection is rebuilt, because a stale keep-alive socket and a genuine
    network problem are indistinguishable on the first attempt.
    """
    global _transport_errors

    clean = {k: v for k, v in params.items() if v is not None}
    for k, v in list(clean.items()):
        if isinstance(v, bool):
            clean[k] = "true" if v else "false"
        elif isinstance(v, (dict, list)):
            clean[k] = json.dumps(v, separators=(",", ":"))
    qs = urllib.parse.urlencode(clean, quote_via=urllib.parse.quote)
    target = path + (f"?{qs}" if qs else "")
    host = urllib.parse.urlparse(base).netloc

    last = ""
    for attempt in range(retries):
        t0 = time.perf_counter()
        try:
            c = _conn(host)
            c.request("GET", target, headers={
                "Host": host, "Accept": "application/json",
                "Connection": "keep-alive", "User-Agent": "devnexus-suite/1.0",
            })
            resp = c.getresponse()
            raw = resp.read().decode("utf-8", "replace")
            ms = (time.perf_counter() - t0) * 1000
            try:
                return Response(resp.status, json.loads(raw), ms, raw)
            except json.JSONDecodeError:
                return Response(resp.status, {}, ms, raw)
        except Exception as exc:  # noqa: BLE001
            last = f"{type(exc).__name__}: {exc}"
            _drop(host)
            if attempt < retries - 1:
                # Backoff gives the resolver room to recover.
                time.sleep(0.6 * (attempt + 1))

    with _err_lock:
        _transport_errors += 1
    return Response(0, {}, 0.0, f"transport (after {retries} tries): {last}")


def poll(fn, *, tries: int = 12, delay: float = 4.0):
    """Repeat fn() until it returns something truthy. Returns the last value.

    The first check happens immediately, so work that is already done costs
    nothing. Only a miss pays the delay.
    """
    last = None
    for i in range(tries):
        last = fn()
        if last:
            return last
        if i < tries - 1:
            time.sleep(delay)
    return last


def parallel(items, worker, *, workers: int = 8):
    """Map worker over items concurrently, preserving input order.

    The suite's slowest stages are loops over INDEPENDENT things — eight
    domains, thirteen uploads, eleven analytics metrics — each waiting on a
    queue or a network round trip to Mumbai. Running them one at a time means
    the whole suite is a sum of latencies instead of a max.

    Only use this where the items genuinely do not interact. Anything that
    mutates shared state (promoting a strategy, rewriting guardrails) must stay
    sequential, which is why this is an explicit opt-in rather than the default.

    Exceptions are returned in place of a result so one failure cannot take out
    the batch.
    """
    from concurrent.futures import ThreadPoolExecutor

    items = list(items)
    if not items:
        return []
    if len(items) == 1:
        try:
            return [worker(items[0])]
        except Exception as exc:  # noqa: BLE001
            return [exc]

    def guarded(x):
        try:
            return worker(x)
        except Exception as exc:  # noqa: BLE001
            return exc

    with ThreadPoolExecutor(max_workers=min(workers, len(items))) as pool:
        return list(pool.map(guarded, items))


# ════════════════════════════════════════════════════════════════════════
#  Results
# ════════════════════════════════════════════════════════════════════════

PASS = "PASS"
FAIL = "FAIL"
BLOCKED = "BLOCKED"
SKIP = "NOT AUTOMATED"


@dataclass
class Result:
    test_id: str
    status: str
    actual: str
    evidence: str = ""
    notes: str = ""


class Results:
    """Collects results and prints progress as it goes.

    Guarded by a lock because stages now run their independent cases in
    parallel, and two threads printing or writing the dict at once would
    interleave output and lose entries.
    """

    def __init__(self):
        self.items: dict[str, Result] = {}
        self._order: list[str] = []
        self._lock = __import__("threading").Lock()

    def add(self, test_id: str, status: str, actual: str, evidence: str = "", notes: str = ""):
        icon = {PASS: "\033[32m✓\033[0m", FAIL: "\033[31m✗\033[0m",
                BLOCKED: "\033[33m!\033[0m", SKIP: "\033[90m-\033[0m"}.get(status, "?")
        with self._lock:
            print(f"  {icon} {test_id:<12} {actual[:110]}", flush=True)
            self.items[test_id] = Result(test_id, status, actual, evidence, notes)
            if test_id not in self._order:
                self._order.append(test_id)

    def ok(self, test_id, cond, good, bad, evidence="", notes=""):
        """Record PASS when cond is truthy, else FAIL."""
        self.add(test_id, PASS if cond else FAIL, good if cond else bad, evidence, notes)
        return bool(cond)

    def counts(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for r in self.items.values():
            out[r.status] = out.get(r.status, 0) + 1
        return out


# ════════════════════════════════════════════════════════════════════════
#  xlsx read / write  (no openpyxl — nothing installed locally)
# ════════════════════════════════════════════════════════════════════════

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def _col_idx(ref: str) -> int:
    n = 0
    for ch in re.match(r"([A-Z]+)", ref).group(1):
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def _col_name(i: int) -> str:
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def read_sheet(xlsx_path: str, sheet: str = "xl/worksheets/sheet1.xml") -> list[list[str]]:
    import xml.etree.ElementTree as ET

    z = zipfile.ZipFile(xlsx_path)
    shared: list[str] = []
    if "xl/sharedStrings.xml" in z.namelist():
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in root.findall(f"{NS}si"):
            shared.append("".join(t.text or "" for t in si.iter(f"{NS}t")))

    ws = ET.fromstring(z.read(sheet))
    rows: list[list[str]] = []
    for r in ws.iter(f"{NS}row"):
        cells: dict[int, str] = {}
        for c in r.findall(f"{NS}c"):
            isx = c.find(f"{NS}is")
            v = c.find(f"{NS}v")
            if isx is not None:
                val = "".join(t.text or "" for t in isx.iter(f"{NS}t"))
            elif v is None:
                val = ""
            elif c.get("t") == "s":
                val = shared[int(v.text)]
            else:
                val = v.text or ""
            cells[_col_idx(c.get("r"))] = val
        if cells:
            rows.append([cells.get(i, "") for i in range(max(cells) + 1)])
    return rows


def _esc(s: str) -> str:
    s = str(s)
    # Strip control characters Excel refuses to open.
    s = "".join(ch for ch in s if ch >= " " or ch in "\t\n")
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
             .replace('"', "&quot;"))


def write_xlsx(path: str, sheets: dict[str, list[list[str]]]) -> None:
    """Write a multi-sheet workbook using inline strings only."""
    names = list(sheets)

    def sheet_xml(rows: list[list[str]]) -> str:
        parts = [
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
            "<sheetData>",
        ]
        for ri, row in enumerate(rows, start=1):
            parts.append(f'<row r="{ri}">')
            for ci, val in enumerate(row):
                if val in (None, ""):
                    continue
                ref = f"{_col_name(ci)}{ri}"
                parts.append(
                    f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">'
                    f"{_esc(val)}</t></is></c>"
                )
            parts.append("</row>")
        parts.append("</sheetData></worksheet>")
        return "".join(parts)

    wb_sheets = "".join(
        f'<sheet name="{_esc(n)}" sheetId="{i+1}" r:id="rId{i+1}"/>'
        for i, n in enumerate(names)
    )
    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f"<sheets>{wb_sheets}</sheets></workbook>"
    )
    wb_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + "".join(
            f'<Relationship Id="rId{i+1}" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
            f'Target="worksheets/sheet{i+1}.xml"/>'
            for i in range(len(names))
        )
        + "</Relationships>"
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + "".join(
            f'<Override PartName="/xl/worksheets/sheet{i+1}.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            for i in range(len(names))
        )
        + "</Types>"
    )
    root_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="xl/workbook.xml"/></Relationships>'
    )

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", root_rels)
        z.writestr("xl/workbook.xml", workbook)
        z.writestr("xl/_rels/workbook.xml.rels", wb_rels)
        for i, n in enumerate(names):
            z.writestr(f"xl/worksheets/sheet{i+1}.xml", sheet_xml(sheets[n]))
