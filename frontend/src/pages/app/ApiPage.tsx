import { useState } from 'react';
import { analyticsApi, itemsApi, projectsApi, runtimeApi } from '@/api/endpoints';
import { KeyValues, Note, PageHeader, Row, Stack, Well } from '@/components/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { healthLabel } from '@/components/HealthBadge';
import { Button, LinkButton } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, Metric, MetricGrid } from '@/components/ui/Card';
import { CodeBlock, CodeTabs, InlineCode, SecretValue, type CodeTab } from '@/components/ui/Code';
import { ApiDirectory, apiGroups } from '@/components/wizard/ApiDirectory';
import { Select } from '@/components/ui/Field';
import { EmptyState, ErrorState, Loading } from '@/components/ui/Feedback';
import { Icon } from '@/components/ui/Icon';
import { ConfirmDialog } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useAsync, useMutation } from '@/hooks/useAsync';
import { useSession } from '@/hooks/useSession';
import { money, ms, number } from '@/lib/format';
import { readHealth } from '@/lib/health';

/**
 * API integration.
 *
 * The page a developer is sent to, so it is built around copying things: the
 * key, the URLs, and working snippets in four languages. Every URL shown is the
 * one the server reported in `/projects/get`, not a string assembled here —
 * assembling it is how a docs page ends up telling people the wrong hostname.
 *
 * The key is masked by default and copyable without being revealed, because the
 * common action is pasting it into a config file.
 */

const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');

export default function ApiPage() {
  const { project, projectId, refresh } = useSession();
  const toast = useToast();
  const [rotating, setRotating] = useState(false);
  const [testItem, setTestItem] = useState('');

  const detail = useAsync(
    (signal) => projectsApi.get(projectId!, { signal }),
    [projectId],
    { enabled: !!projectId },
  );

  const system = useAsync(
    (signal) => analyticsApi.system(projectId!, { signal }),
    [projectId],
    { enabled: !!projectId, pollMs: 60_000 },
  );

  const items = useAsync(
    (signal) => itemsApi.list(projectId!, { limit: 20 }, { signal }),
    [projectId],
    { enabled: !!projectId },
  );

  const rotate = useMutation(() => projectsApi.rotateKey(projectId!), {
    onSuccess: () => {
      setRotating(false);
      toast.success(
        'API key rotated',
        'The old key stops working within a minute. Update your application now.',
      );
      detail.refetch();
      void refresh();
    },
  });

  /**
   * A live call against the real pricing API, from the browser.
   *
   * This is the single most useful thing on the page: it proves the key works
   * and shows the exact response shape, rather than describing both.
   */
  const [testResult, setTestResult] = useState<string | null>(null);
  const tryIt = useMutation(
    async (key: string, itemId: string) => {
      const started = performance.now();
      const result = await runtimeApi.price(key, itemId);
      return { result, elapsed: performance.now() - started };
    },
    {
      onSuccess: ({ result, elapsed }) => {
        setTestResult(
          `${JSON.stringify(result, null, 2)}\n\n// round trip from your browser: ${elapsed.toFixed(0)} ms`,
        );
      },
      onError: (e) => setTestResult(`// ${e.code}: ${e.message}`),
    },
  );

  if (!project) {
    return (
      <Card>
        <EmptyState
          icon="api"
          title="No project selected"
          body="Create a project to get a pricing API."
          action={
            <LinkButton to="/app/projects/new" variant="primary" icon="plus">
              Create a project
            </LinkButton>
          }
        />
      </Card>
    );
  }

  if (detail.initialLoading) return <Loading label="Loading your API details" />;
  if (detail.error) return <ErrorState error={detail.error} onRetry={detail.refetch} />;

  const d = detail.data;
  if (!d) return null;

  const apiKey = d.api_key;
  const health = readHealth(system.data);
  const exampleItem = testItem || items.data?.items?.[0]?.item_id || 'ITEM_ID';
  const exampleSignal = d.schema?.context_signals?.[0]?.id ?? 'demand_score';
  const isLive = d.project.mode === 'active';

  return (
    <Stack>
      <PageHeader
        title={isLive ? 'Your pricing API is ready' : 'Your pricing API'}
        description={
          isLive
            ? 'This project is live. Every call below returns a real price from your active strategy.'
            : 'The API works now, but no strategy is active — calls return each item’s base price until you activate one.'
        }
        badge={
          isLive ? (
            <Badge tone="success" icon="check">
              Live
            </Badge>
          ) : (
            <Badge tone="warning">Not active</Badge>
          )
        }
      />

      {!isLive && (
        <Card tone="accent" pad="sm">
          <Row>
            <Icon name="info" size={16} style={{ color: 'var(--accent)' }} />
            <span style={{ fontSize: 'var(--t-sm)' }}>
              You can integrate and test now. Activate a strategy when you want rules applied.
            </span>
            <LinkButton to="/app/strategies" size="sm" variant="secondary">
              Strategies
            </LinkButton>
          </Row>
        </Card>
      )}

      {/* ── key ────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Project API key"
          subtitle="This key identifies this project. It belongs in your server configuration — never in client-side code."
          actions={
            <Button size="sm" variant="danger" icon="refresh" onClick={() => setRotating(true)}>
              Rotate
            </Button>
          }
        />
        <CardBody>
          <SecretValue value={apiKey} />
          <div style={{ marginTop: 'var(--s-4)' }}>
            <Note>
              Anyone with this key can request prices for this project. Rotating it immediately
              invalidates the old one.
            </Note>
          </div>
        </CardBody>
      </Card>

      {/* ── health ─────────────────────────────────────────────────────── */}
      <MetricGrid>
        <Metric label="Requests" icon="api" value={number(health.requests)} foot="last hour" />
        <Metric label="Typical response" icon="clock" value={ms(health.p50)} foot="p50" />
        <Metric label="Slowest 1 in 20" icon="clock" value={ms(health.p95)} foot="p95" />
        <Metric
          label="Status"
          icon="shield"
          value={
            healthLabel(health.verdict)
          }
          foot={health.summary}
        />
      </MetricGrid>

      {/* ── endpoints ──────────────────────────────────────────────────
          Grouped by the job each one does, and by which credential it takes.
          A flat list put the two hot-path endpoints next to six administrative
          ones, which is how a project key ends up in a browser. */}
      <Card>
        <CardHeader
          title="Endpoints"
          subtitle="Everything is a GET with parameters in the URL. There are no request bodies."
        />
        <CardBody>
          <ApiDirectory base={API_BASE} groups={apiGroups(apiKey, exampleItem, exampleSignal)} />
        </CardBody>
      </Card>

      {/* ── try it ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Try it now"
          subtitle="Calls the real API from your browser, with your real key."
        />
        <CardBody>
          <Stack>
            <Row>
              {(items.data?.items ?? []).length > 0 ? (
                <Select
                  aria-label="Item to price"
                  value={exampleItem}
                  options={(items.data?.items ?? []).map((i) => ({
                    value: i.item_id,
                    label: `${i.name} (${i.item_id}) — ${money(i.base_price, d.project.currency)}`,
                  }))}
                  onChange={(e) => setTestItem(e.target.value)}
                />
              ) : (
                <Note>Add an item first — there is nothing to price yet.</Note>
              )}
              <Button
                variant="primary"
                icon="play"
                loading={tryIt.pending}
                disabled={(items.data?.items ?? []).length === 0}
                onClick={() => void tryIt.run(apiKey, exampleItem)}
              >
                Send the request
              </Button>
            </Row>

            {testResult && <CodeBlock code={testResult} title="Response" />}
          </Stack>
        </CardBody>
      </Card>

      {/* ── snippets ───────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Integrate"
          subtitle="Copy one of these into your application. Replace the key with an environment variable."
        />
        <CardBody>
          <Stack>
            <div>
              <strong style={{ fontSize: 'var(--t-sm)' }}>Get a price</strong>
              <div style={{ marginTop: 'var(--s-2)' }}>
                <CodeTabs tabs={priceSnippets(apiKey, exampleItem)} />
              </div>
            </div>

            <div>
              <strong style={{ fontSize: 'var(--t-sm)' }}>Report an event</strong>
              <div style={{ marginTop: 'var(--s-2)' }}>
                <CodeTabs tabs={eventSnippets(apiKey, exampleItem)} />
              </div>
            </div>
          </Stack>
        </CardBody>
      </Card>

      {/* ── custom signals ────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Sending your own signals"
          subtitle="Any signal in your schema can be pushed directly, which is what keeps DevNexus domain-agnostic."
        />
        <CardBody>
          <Stack>
            <Note>
              Add <code>signal_&lt;id&gt;=&lt;value&gt;</code> to any event call. The id is whatever
              your domain schema declares — DevNexus does not need to know what it means.
            </Note>
            <CodeBlock
              title="Push a custom signal"
              code={`${API_BASE}/v1/t/${apiKey}/event?item_id=${exampleItem}&event_type=signal_update${signalExample(
                d.schema?.context_signals ?? [],
              )}`}
            />
            {(d.schema?.context_signals ?? []).length > 0 && (
              <Well>
                <strong style={{ fontSize: 'var(--t-sm)' }}>Signals in this project</strong>
                <div style={{ marginTop: 'var(--s-3)' }}>
                  <KeyValues
                    rows={(d.schema?.context_signals ?? []).map((sig) => ({
                      key: sig.label,
                      value: <InlineCode value={`signal_${sig.id}`} copyable={false} />,
                    }))}
                  />
                </div>
              </Well>
            )}
          </Stack>
        </CardBody>
      </Card>

      <ConfirmDialog
        open={rotating}
        onClose={() => {
          setRotating(false);
          rotate.reset();
        }}
        onConfirm={() => void rotate.run()}
        title="Rotate the API key?"
        body="A new key is issued immediately and the current one stops working."
        consequence="Any application still using the old key will start getting 401 responses within about a minute. Make sure you can deploy the new key before you do this."
        details={[
          { label: 'Project', value: d.project.name },
          { label: 'Current key', value: `…${apiKey.slice(-6)}` },
        ]}
        confirmLabel="Rotate the key"
        pending={rotate.pending}
        error={rotate.error}
      />
    </Stack>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Snippets
   ═══════════════════════════════════════════════════════════════════════ */

function priceSnippets(key: string, itemId: string): CodeTab[] {
  const url = `${API_BASE}/v1/p/${key}/price`;
  return [
    {
      id: 'curl',
      label: 'cURL',
      code: `curl -s "${url}?item_id=${itemId}"`,
    },
    {
      id: 'js',
      label: 'JavaScript',
      code: `const KEY = process.env.DEVNEXUS_KEY;

async function getPrice(itemId) {
  const res = await fetch(
    \`${API_BASE}/v1/p/\${KEY}/price?item_id=\${encodeURIComponent(itemId)}\`,
    { cache: 'no-store' },
  );
  const body = await res.json();
  if (!body.ok) throw new Error(body.error.message);

  // Keep decision_id with the order: it is how you explain this price later.
  return { price: body.price.price, decisionId: body.price.decision_id };
}`,
    },
    {
      id: 'python',
      label: 'Python',
      code: `import os
import urllib.parse
import requests

KEY = os.environ["DEVNEXUS_KEY"]
BASE = "${API_BASE}"


def get_price(item_id: str) -> dict:
    url = f"{BASE}/v1/p/{KEY}/price"
    res = requests.get(url, params={"item_id": item_id}, timeout=5)
    body = res.json()
    if not body.get("ok"):
        raise RuntimeError(body["error"]["message"])
    return body["price"]`,
    },
    {
      id: 'java',
      label: 'Java',
      code: `var key = System.getenv("DEVNEXUS_KEY");
var itemId = URLEncoder.encode("${itemId}", StandardCharsets.UTF_8);

var request = HttpRequest.newBuilder()
    .uri(URI.create("${API_BASE}/v1/p/" + key + "/price?item_id=" + itemId))
    .header("Accept", "application/json")
    .timeout(Duration.ofSeconds(5))
    .GET()
    .build();

var response = HttpClient.newHttpClient()
    .send(request, HttpResponse.BodyHandlers.ofString());`,
    },
  ];
}

function eventSnippets(key: string, itemId: string): CodeTab[] {
  const url = `${API_BASE}/v1/t/${key}/event`;
  return [
    {
      id: 'curl',
      label: 'cURL',
      code: `curl -s "${url}?item_id=${itemId}&event_type=purchase&quantity=1&event_id=ord_8f21c4"`,
    },
    {
      id: 'js',
      label: 'JavaScript',
      code: `// event_id makes this idempotent — a retry will not double-count.
async function reportPurchase(itemId, orderId, quantity) {
  const params = new URLSearchParams({
    item_id: itemId,
    event_type: 'purchase',
    event_id: orderId,
    quantity: String(quantity),
  });
  await fetch(\`${API_BASE}/v1/t/\${process.env.DEVNEXUS_KEY}/event?\${params}\`);
}`,
    },
    {
      id: 'python',
      label: 'Python',
      code: `def report_purchase(item_id: str, order_id: str, quantity: int) -> None:
    requests.get(
        f"{BASE}/v1/t/{KEY}/event",
        params={
            "item_id": item_id,
            "event_type": "purchase",
            # Pass your own id so a retry is not counted twice.
            "event_id": order_id,
            "quantity": quantity,
        },
        timeout=3,
    )`,
    },
    {
      id: 'java',
      label: 'Java',
      code: `var params = "item_id=" + itemId
    + "&event_type=purchase"
    + "&event_id=" + orderId
    + "&quantity=1";

var request = HttpRequest.newBuilder()
    .uri(URI.create("${API_BASE}/v1/t/" + key + "/event?" + params))
    .GET()
    .build();

HttpClient.newHttpClient().sendAsync(request, HttpResponse.BodyHandlers.discarding());`,
    },
  ];
}

/** Build a realistic signal example from the project's own schema. */
function signalExample(signals: readonly { id: string; min?: number | null; max?: number | null }[]): string {
  const pick = signals.slice(0, 2);
  if (pick.length === 0) return '&signal_your_signal_id=42';
  return pick
    .map((sig) => {
      const mid =
        sig.min !== undefined && sig.min !== null && sig.max !== undefined && sig.max !== null
          ? Math.round((sig.min + sig.max) / 2)
          : 42;
      return `&signal_${sig.id}=${mid}`;
    })
    .join('');
}
