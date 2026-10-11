import { useMemo } from 'react';

import { projectsApi } from '@/api/endpoints';
import { PageHeader } from '@/components/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { LinkButton } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState, ErrorState, Loading } from '@/components/ui/Feedback';
import { Icon } from '@/components/ui/Icon';
import { useAsync } from '@/hooks/useAsync';
import { useSession } from '@/hooks/useSession';

/* The three scopes, in the order the engine reads them, with plain-language
   explanations of where each value lives. */
const SCOPES = [
  {
    key: 'item',
    title: 'Product / item level',
    blurb: 'Stored on each product — a different value per item.',
    icon: 'projects' as const,
    tone: 'accent' as const,
  },
  {
    key: 'global',
    title: 'Global / overall level',
    blurb: 'One value shared by the whole project, right now.',
    icon: 'analytics' as const,
    tone: 'info' as const,
  },
  {
    key: 'request',
    title: 'User / request level',
    blurb: 'Supplied with each price call — never stored.',
    icon: 'api' as const,
    tone: 'success' as const,
  },
];

type Sig = { id: string; label?: string; type?: string; scope?: string; enum?: unknown; description?: string };

function SignalRow({ s }: { s: Sig }) {
  const enumVals = Array.isArray(s.enum) ? (s.enum as string[]) : null;
  return (
    <div
      style={{
        display: 'flex', alignItems: 'baseline', gap: 12, padding: '10px 2px',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <code style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text)', minWidth: 170 }}>{s.id}</code>
      <span style={{ flex: 1, fontSize: 13, color: 'var(--text-secondary)' }}>
        {s.label || '—'}
        {enumVals && (
          <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
            {'  '}· {enumVals.join(' / ')}
          </span>
        )}
      </span>
      <Badge tone="neutral" caps>{s.type || 'number'}</Badge>
    </div>
  );
}

export default function SchemaPage() {
  const { project, projectId } = useSession();

  const detail = useAsync(
    (signal) => projectsApi.get(projectId!, { signal }),
    [projectId],
    { enabled: !!projectId },
  );

  const grouped = useMemo(() => {
    const d = detail.data;
    const g: { item: Sig[]; global: Sig[]; request: Sig[] } = { item: [], global: [], request: [] };
    if (!d) return g;
    for (const s of (d.schema?.context_signals ?? []) as Sig[]) {
      const scope = (s.scope as string) || 'item';
      if (scope === 'global') g.global.push(s);
      else if (scope === 'request') g.request.push(s);
      else g.item.push(s);
    }
    return g;
  }, [detail.data]);

  if (!projectId) {
    return (
      <Card>
        <EmptyState
          icon="rules"
          title="No project selected"
          body="Open a project to see its schema."
          action={<LinkButton to="/app/projects/new" variant="primary" icon="plus">Create a project</LinkButton>}
        />
      </Card>
    );
  }

  const d = detail.data;
  const builtins = (d?.builtin_signals ?? []) as Sig[];
  const guardrails = (d?.guardrails ?? {}) as Record<string, number | null | undefined>;
  const totalSignals = (d?.schema?.context_signals ?? []).length;

  const GUARD_LABELS: Record<string, string> = {
    min_price: 'Min price',
    max_price: 'Max price',
    max_increase_pct: 'Max increase',
    max_decrease_pct: 'Max decrease',
    min_margin_pct: 'Min margin',
  };
  const guardEntries = Object.entries(guardrails).filter(([, v]) => v != null);

  return (
    <>
      <PageHeader
        title="Schema"
        description="Everything this project prices with today — its signals, by scope, and the limits around them."
        badge={project?.name ? <Badge tone="neutral">{project.name}</Badge> : undefined}
      />

      {detail.loading && <Loading label="Loading the schema" />}
      {detail.error && <ErrorState error={detail.error} onRetry={detail.refetch} />}

      {d && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card>
            <CardBody>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, fontSize: 13, color: 'var(--text-secondary)' }}>
                <span><b style={{ color: 'var(--text)' }}>{totalSignals}</b> signals</span>
                <span><b style={{ color: 'var(--text)' }}>{d.project?.item_count ?? 0}</b> products</span>
                <span><b style={{ color: 'var(--text)' }}>{guardEntries.length}</b> guardrails</span>
                <span style={{ color: 'var(--text-muted)' }}>domain: {d.schema?.domain_name || d.project?.domain_name}</span>
              </div>
            </CardBody>
          </Card>

          {SCOPES.map((sc) => {
            const sigs = grouped[sc.key as 'item' | 'global' | 'request'];
            const isItem = sc.key === 'item';
            if (sigs.length === 0 && !(isItem && builtins.length)) return null;
            return (
              <Card key={sc.key}>
                <CardHeader
                  title={
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <Icon name={sc.icon} size={16} /> {sc.title}
                      <Badge tone={sc.tone} caps>{sigs.length + (isItem ? builtins.length : 0)}</Badge>
                    </span>
                  }
                  subtitle={sc.blurb}
                />
                <CardBody>
                  {isItem && builtins.length > 0 && (
                    <div style={{ marginBottom: sigs.length ? 12 : 0 }}>
                      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text-muted)', marginBottom: 4 }}>
                        Built-in (every product has these)
                      </div>
                      {builtins.map((b) => <SignalRow key={b.id} s={b} />)}
                    </div>
                  )}
                  {sigs.map((s) => <SignalRow key={s.id} s={s} />)}
                </CardBody>
              </Card>
            );
          })}

          <Card>
            <CardHeader
              title={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Icon name="shield" size={16} /> Guardrails</span>}
              subtitle="The hard limits the price can never cross — applied after the rules."
              actions={<LinkButton to="/app/project/settings" variant="secondary" size="sm">Edit</LinkButton>}
            />
            <CardBody>
              {guardEntries.length === 0 ? (
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>No guardrails set.</span>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                  {guardEntries.map(([k, v]) => (
                    <div key={k} style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: '10px 14px', minWidth: 120 }}>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{GUARD_LABELS[k] ?? k}</div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 600 }}>
                        {k.endsWith('_pct') ? `${v}%` : v}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>

          <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
            This is read-only. Change signals in the schema builder, or limits under Guardrails.
          </div>
        </div>
      )}
    </>
  );
}
