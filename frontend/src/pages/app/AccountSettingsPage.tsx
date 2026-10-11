import { useNavigate } from 'react-router-dom';
import { aiApi } from '@/api/endpoints';
import { KeyValues, Note, PageHeader, Row, Stack, Well } from '@/components/PageHeader';
import { Badge, ModeBadge } from '@/components/ui/Badge';
import { Button, LinkButton } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState, Loading } from '@/components/ui/Feedback';
import { Icon } from '@/components/ui/Icon';
import { useAsync } from '@/hooks/useAsync';
import { useSession } from '@/hooks/useSession';
import { number, plural } from '@/lib/format';

/**
 * Account settings — everything that is true of the whole account.
 *
 * Deliberately NOT the place for guardrails, limits or anything a project
 * owns: those live at /app/project/settings, inside the project they belong
 * to. The split matters because a guardrail set on the wrong project is a
 * real pricing incident, and a screen that mixes the two scopes invites it.
 *
 * Only what the backend actually supports. There is no profile editor and no
 * account deletion, because those endpoints do not exist — inventing the
 * screens would be promising something the product cannot do.
 */
export default function AccountSettingsPage() {
  const { user, tenant, projects, catalog, selectProject, signOut } = useSession();
  const navigate = useNavigate();

  // Account-scoped: the assistant's keys are shared by every project, so its
  // health belongs here rather than on any one project's settings.
  const ai = useAsync((signal) => aiApi.health({ signal }), []);

  const live = projects.filter((p) => p.mode === 'active').length;
  const drafts = projects.filter((p) => p.mode === 'draft').length;

  const openProject = (projectId: string, mode: string) => {
    if (mode === 'draft') {
      navigate('/app/projects/new');
      return;
    }
    selectProject(projectId);
    navigate('/app/project/settings');
  };

  return (
    <Stack>
      <PageHeader
        title="Account settings"
        description="Your account and the assistant. Pricing limits are set inside each project."
        actions={
          <LinkButton to="/app" variant="ghost" size="sm" icon="overview">
            Back to all projects
          </LinkButton>
        }
      />

      {/* ── account ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader title="Your account" />
        <CardBody>
          <KeyValues
            rows={[
              { key: 'Email', value: user?.email ?? '—' },
              { key: 'Company', value: tenant?.company_name ?? '—' },
              {
                key: 'Industry',
                // The tenant stores the catalog id ("ecommerce"); the catalog
                // holds the label a human picked ("E-commerce").
                value:
                  catalog?.service_types.find((t) => t.id === tenant?.service_type)?.label ??
                  tenant?.service_type ??
                  '—',
              },
              { key: 'Default currency', value: tenant?.currency ?? '—' },
              { key: 'Country', value: tenant?.country ?? '—' },
              {
                key: 'Projects',
                value: `${plural(projects.length, 'project')} · ${live} live${
                  drafts > 0 ? ` · ${drafts} in setup` : ''
                }`,
              },
            ]}
          />
          <div style={{ marginTop: 'var(--s-4)' }}>
            <Note>
              Account details are set once during sign-up and cannot be changed from here.
            </Note>
          </div>
        </CardBody>
      </Card>

      {/* ── per-project settings, as links ─────────────────────────────── */}
      <Card>
        <CardHeader
          title="Project settings"
          subtitle="Prices, rules and safety limits belong to a project. Open one to change them."
        />
        {projects.length === 0 ? (
          <EmptyState
            icon="projects"
            title="No projects yet"
            body="A project holds one pricing system — what you sell, the rules that move the price, and the limits it must stay inside."
            action={
              <LinkButton to="/app/projects/new" variant="primary" icon="plus">
                Create a project
              </LinkButton>
            }
          />
        ) : (
          <CardBody tight>
            <KeyValues
              rows={projects.map((p) => ({
                key: p.name,
                value: (
                  <Row>
                    <ModeBadge mode={p.mode} />
                    <Button
                      variant="ghost"
                      size="sm"
                      iconAfter="arrow-right"
                      onClick={() => openProject(p.project_id, p.mode)}
                    >
                      {p.mode === 'draft' ? 'Finish setup' : 'Settings'}
                    </Button>
                  </Row>
                ),
              }))}
            />
          </CardBody>
        )}
      </Card>

      {/* ── AI assistant status ────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="AI assistant"
          subtitle="Used only to draft configuration from a description. It never prices anything."
          actions={
            ai.data ? (
              ai.data.healthy ? (
                <Badge tone="success" icon="check">
                  Available
                </Badge>
              ) : (
                <Badge tone="warning" icon="warning">
                  Unavailable
                </Badge>
              )
            ) : null
          }
        />
        <CardBody>
          {ai.initialLoading ? (
            <Loading label="Checking the assistant" inline />
          ) : ai.error ? (
            <Note>The assistant status could not be read. Rule drafting may be unavailable.</Note>
          ) : ai.data ? (
            <Stack>
              <KeyValues
                rows={[
                  { key: 'Keys available', value: number(ai.data.keys?.usable ?? null) },
                  {
                    key: 'Models ready',
                    value: `${number(
                      (ai.data.models ?? []).filter((m) => m.available).length,
                    )} of ${number(ai.data.models?.length ?? 0)}`,
                  },
                  {
                    key: 'Preferred model',
                    value: (ai.data.models ?? []).find((m) => m.available)?.model ?? 'none ready',
                  },
                ]}
              />
              <Well>
                <Row>
                  <Icon name="shield" size={15} style={{ color: 'var(--accent)' }} />
                  <strong style={{ fontSize: 'var(--t-sm)' }}>What the assistant can do</strong>
                </Row>
                <p
                  style={{
                    marginTop: 'var(--s-2)',
                    fontSize: 'var(--t-sm)',
                    color: 'var(--text-secondary)',
                    lineHeight: 'var(--lh-normal)',
                  }}
                >
                  It turns a sentence into a draft rule for you to review. It cannot save a rule,
                  switch pricing on, or change a price. Every pricing decision is made by the
                  deterministic engine.
                </p>
              </Well>
            </Stack>
          ) : null}
        </CardBody>
      </Card>

      {/* ── session ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader title="Session" subtitle="Signing out ends this session on this device only." />
        <CardBody>
          <Button
            variant="secondary"
            icon="logout"
            onClick={() => {
              signOut();
              navigate('/', { replace: true });
            }}
          >
            Sign out
          </Button>
        </CardBody>
      </Card>
    </Stack>
  );
}
