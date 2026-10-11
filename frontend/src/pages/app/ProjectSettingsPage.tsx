import { useEffect, useState } from 'react';
import { projectsApi, strategiesApi, type Guardrails } from '@/api/endpoints';
import { Note, PageHeader, Row, Stack } from '@/components/PageHeader';
import { LinkButton, Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Input } from '@/components/ui/Field';
import { EmptyState, ErrorState, Loading } from '@/components/ui/Feedback';
import { cx } from '@/lib/cx';
import s2 from './ProjectSettings.module.css';
import { useToast } from '@/components/ui/Toast';
import { useAsync, useMutation } from '@/hooks/useAsync';
import { useAgentSurface } from '@/hooks/useProjectAgent';
import { useSession } from '@/hooks/useSession';

/**
 * Guardrails — the limits this project must stay inside.
 *
 * One job, one screen. The on/off switch moved to the app bar (it is a control,
 * not a setting) and the project's reference details moved out entirely (they
 * were facts to read, not things to change), which leaves exactly the thing
 * this page is named for.
 *
 * They are applied AFTER every rule, so a mistake in a rule cannot reach a
 * customer — which is why they are edited in sight of the project name.
 */
export default function ProjectSettingsPage() {
  const { project, projectId } = useSession();
  const toast = useToast();

  const detail = useAsync(
    (signal) => projectsApi.get(projectId!, { signal }),
    [projectId],
    { enabled: !!projectId },
  );

  const [limits, setLimits] = useState<Record<keyof Guardrails, string>>({
    min_price: '',
    max_price: '',
    max_increase_pct: '',
    max_decrease_pct: '',
    min_margin_pct: '',
  });
  const [dirty, setDirty] = useState(false);

  const requireApproval = !!detail.data?.project.require_approval;
  const setApproval = useMutation(
    (require: boolean) => strategiesApi.setApprovalPolicy(projectId!, require),
    {
      onSuccess: () => {
        toast.success('Approval policy updated');
        detail.refetch();
      },
    },
  );

  // Seed the form from the server once the project has loaded. Guarded on
  // `dirty` so a poll or refetch cannot overwrite what the user is typing.
  useEffect(() => {
    const g = detail.data?.guardrails;
    if (!g || dirty) return;
    setLimits({
      min_price: valueOf(g, 'min_price'),
      max_price: valueOf(g, 'max_price'),
      max_increase_pct: valueOf(g, 'max_increase_pct'),
      max_decrease_pct: valueOf(g, 'max_decrease_pct'),
      min_margin_pct: valueOf(g, 'min_margin_pct'),
    });
  }, [detail.data, dirty]);

  const saveGuardrails = useMutation(
    () => {
      // Every field is included, because the endpoint REPLACES the whole set —
      // sending only the changed ones would silently clear the rest. A blank
      // field is sent as null, which the client turns into an omitted parameter
      // and the server reads as "not enforced".
      const payload: Guardrails = {};
      for (const [key, raw] of Object.entries(limits) as [keyof Guardrails, string][]) {
        payload[key] = raw === '' || Number.isNaN(Number(raw)) ? null : Number(raw);
      }
      return projectsApi.saveGuardrails(projectId!, payload);
    },
    {
      onSuccess: () => {
        setDirty(false);
        toast.success('Limits saved', 'They apply to the very next pricing decision.');
        detail.refetch();
      },
    },
  );

  // The assistant fills the limit boxes; it does NOT save them. Guardrails are
  // the safety net, so the user reviews the proposed numbers and clicks Save.
  useAgentSurface('limits', (d) => {
    if (d.kind !== 'limit') return null;
    const next: Partial<Record<keyof Guardrails, string>> = {};
    if (d.up !== undefined) next.max_increase_pct = d.up;
    if (d.down !== undefined) next.max_decrease_pct = d.down;
    if (d.margin !== undefined) next.min_margin_pct = d.margin;
    if (!Object.keys(next).length) return null;
    setLimits((l) => ({ ...l, ...next }));
    setDirty(true);
    const parts = [
      d.up !== undefined ? `+${d.up}%` : null,
      d.down !== undefined ? `-${d.down}%` : null,
      d.margin !== undefined ? `margin ${d.margin}%` : null,
    ].filter(Boolean);
    return `limits ${parts.join(' · ')}`;
  });

  if (!project) {
    return (
      <Stack>
        <PageHeader title="Guardrails" description="Open a project to set its limits." />
        <Card>
          <EmptyState
            icon="shield"
            title="No project open"
            body="Safety limits are set per project, because each one prices something different."
            action={
              <LinkButton to="/app" variant="primary" icon="overview">
                Choose a project
              </LinkButton>
            }
          />
        </Card>
      </Stack>
    );
  }

  const currency = project.currency;

  return (
    <Stack>
      <PageHeader
        title="Guardrails"
        description={`The limits ${project.name} must stay inside, whatever the rules decide.`}
      />

      {/* ── guardrails ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Safety limits"
          subtitle="Applied after every rule, so a mistake in a rule can never reach a customer. Changes take effect on the very next pricing decision."
        />
        <CardBody>
          {detail.initialLoading ? (
            <Loading label="Loading limits" inline />
          ) : detail.error ? (
            <ErrorState error={detail.error} onRetry={detail.refetch} />
          ) : (
            <Stack>
              <Row>
                <Input
                  label="Minimum price"
                  type="number"
                  optional
                  prefix={currency}
                  value={limits.min_price}
                  onChange={(e) => {
                    setDirty(true);
                    setLimits((l) => ({ ...l, min_price: e.target.value }));
                  }}
                />
                <Input
                  label="Maximum price"
                  type="number"
                  optional
                  prefix={currency}
                  value={limits.max_price}
                  onChange={(e) => {
                    setDirty(true);
                    setLimits((l) => ({ ...l, max_price: e.target.value }));
                  }}
                />
              </Row>
              <Row>
                <Input
                  label="Maximum increase"
                  type="number"
                  optional
                  suffix="%"
                  value={limits.max_increase_pct}
                  onChange={(e) => {
                    setDirty(true);
                    setLimits((l) => ({ ...l, max_increase_pct: e.target.value }));
                  }}
                />
                <Input
                  label="Maximum decrease"
                  type="number"
                  optional
                  suffix="%"
                  value={limits.max_decrease_pct}
                  onChange={(e) => {
                    setDirty(true);
                    setLimits((l) => ({ ...l, max_decrease_pct: e.target.value }));
                  }}
                />
                <Input
                  label="Minimum margin"
                  type="number"
                  optional
                  suffix="%"
                  value={limits.min_margin_pct}
                  hint="Needs a cost set on each item."
                  onChange={(e) => {
                    setDirty(true);
                    setLimits((l) => ({ ...l, min_margin_pct: e.target.value }));
                  }}
                />
              </Row>

              <Note>
                An empty field means that limit is not enforced. Changes take effect on the very
                next pricing decision — there is nothing to redeploy.
              </Note>

              {saveGuardrails.error && (
                <ErrorState error={saveGuardrails.error} title="Could not save the limits" />
              )}

              <Row>
                <Button
                  variant="primary"
                  icon="shield"
                  loading={saveGuardrails.pending}
                  disabled={!dirty}
                  onClick={() => void saveGuardrails.run()}
                >
                  Save limits
                </Button>
                {dirty && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setDirty(false);
                      detail.refetch();
                    }}
                  >
                    Discard changes
                  </Button>
                )}
              </Row>
            </Stack>
          )}
        </CardBody>
      </Card>

      {/* ── publish approval ─────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Approval to publish"
          subtitle="When on, turning pricing on or activating a new strategy waits for an approval before it goes live — recorded in the audit trail."
        />
        <CardBody>
          <Row>
            <button
              type="button"
              role="switch"
              aria-checked={requireApproval}
              aria-label="Require approval to publish"
              disabled={setApproval.pending}
              className={cx(s2.approvalSwitch, requireApproval && s2.approvalSwitchOn)}
              onClick={() => void setApproval.run(!requireApproval)}
            >
              <span className={s2.approvalKnob} />
            </button>
            <span style={{ fontSize: 'var(--t-sm)', color: 'var(--text-secondary)' }}>
              {requireApproval
                ? 'Required — changes wait for approval before going live.'
                : 'Not required — changes go live immediately.'}
            </span>
          </Row>
          {setApproval.error && (
            <div style={{ marginTop: 'var(--s-3)' }}>
              <ErrorState compact error={setApproval.error} title="Could not change the policy" />
            </div>
          )}
          <div style={{ marginTop: 'var(--s-3)' }}>
            <Note>
              Approvals appear on the project dashboard. The owner can approve their own change —
              it is still a deliberate checkpoint with a full audit record.
            </Note>
          </div>
        </CardBody>
      </Card>

    </Stack>
  );
}

/**
 * Read a guardrail that may legitimately be absent.
 *
 * `/projects/get` only returns the limits that are configured, so an unset
 * ceiling is a missing key rather than a null — reading it directly off the
 * typed object would be a compile error for the optional ones.
 */
function valueOf(guardrails: Record<string, unknown>, key: string): string {
  const value = guardrails[key];
  return typeof value === 'number' ? String(value) : '';
}
