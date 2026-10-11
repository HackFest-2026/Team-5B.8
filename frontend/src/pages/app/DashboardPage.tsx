import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { analyticsApi, projectsApi } from '@/api/endpoints';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Modal } from '@/components/ui/Modal';
import { Row } from '@/components/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { useAsync, useMutation } from '@/hooks/useAsync';
import { useSession, type Project } from '@/hooks/useSession';
import { cx } from '@/lib/cx';
import { number, plural } from '@/lib/format';
import { EmptyAccount, ProjectGrid } from './parts/ProjectGrid';
import s from './Dashboard.module.css';

/**
 * The account dashboard: a STATUS screen, not an analytics screen.
 *
 * It answers two questions and refuses the rest:
 *
 *   1. what do I have?       → counts of systems, not measurements of them
 *   2. is anything wrong?    → named, actionable, and silent when all is well
 *
 * Prices served, priced value, trends and charts are all project-level figures.
 * Blending them across unrelated businesses produces a number nobody can act
 * on, so none of them appear here. They live inside the project they describe.
 *
 * The one thing this screen genuinely owes the user is the second question: a
 * project that has started failing is invisible everywhere else, because nobody
 * opens a project they believe is fine.
 */
export default function DashboardPage() {
  const navigate = useNavigate();
  const { projects, tenant, user, selectProject, projectId, refresh } = useSession();
  const toast = useToast();
  const [deleting, setDeleting] = useState<Project | null>(null);

  const removeProject = useMutation(
    (id: string) => projectsApi.remove(id),
    {
      onSuccess: async () => {
        const removed = deleting;
        setDeleting(null);
        // If the project being removed was the one in context, drop it so the
        // shell does not try to load a project that no longer exists.
        if (removed && removed.project_id === projectId) {
          try { localStorage.removeItem('devnexus.project'); } catch { /* ignore */ }
        }
        await refresh();
        toast.success(
          'Project deleted',
          removed ? `"${removed.name}" and all its data are gone.` : undefined,
        );
      },
      onError: (e) => toast.error('Could not delete the project', e.message),
    },
  );

  // The only call on this page, and only for the alert. Everything else here
  // comes from the project list `/auth/me` already delivered.
  const pf = useAsync((signal) => analyticsApi.portfolio('24h', { signal }), [projects.length], {
    enabled: projects.length > 0,
    pollMs: 60_000,
  });

  // An empty account has no status to report, so the whole screen becomes the
  // one thing there is to do.
  if (projects.length === 0) return <EmptyAccount />;

  const active = projects.filter((p) => p.mode === 'active').length;
  const drafts = projects.filter((p) => p.mode === 'draft').length;
  const off = projects.length - active - drafts;

  const attention = pf.data?.attention ?? [];
  const industries = new Set(projects.map((p) => p.domain_name).filter(Boolean)).size;
  const products = projects.reduce((n, p) => n + (p.item_count ?? 0), 0);

  const firstName = (user?.name || '').split(' ')[0];
  const allWell = attention.length === 0;

  const open = (projectId: string) => {
    selectProject(projectId);
    navigate('/app/project');
  };

  const openProject = (p: Project) => {
    // A draft has not finished the wizard, so it has no rules and no limits.
    // Opening its dashboard would be an empty room — it resumes setup instead.
    if (p.mode === 'draft') {
      navigate('/app/projects/new');
      return;
    }
    open(p.project_id);
  };

  return (
    <div className={s.page}>
      {/* One board rather than three stacked strips: the verdict, the counts
          behind it and the scale are a single thought, and splitting them left
          a short page with a hole under it. */}
      <section className={cx(s.board, allWell ? s.calm : s.alarm)}>
        <div className={s.glow} aria-hidden="true" />

        <div className={s.verdict}>
          <div className={s.ring} aria-hidden="true">
            <span className={s.dot} />
          </div>

          <div className={s.verdictText}>
            <div className={s.eyebrow}>
              {firstName ? `Welcome back, ${firstName}` : (tenant?.company_name ?? 'Your account')}
            </div>
            <h1 className={s.title}>
              {pf.initialLoading
                ? 'Checking your pricing…'
                : allWell
                  ? active > 0
                    ? 'Everything is running'
                    : 'Nothing is switched on'
                  : `${plural(attention.length, 'system')} need${attention.length === 1 ? 's' : ''} attention`}
            </h1>
            <p className={s.sub}>
              {pf.initialLoading
                ? 'Reading the last 24 hours across every project.'
                : allWell
                  ? active > 0
                    ? 'Every live system priced without falling back.'
                    : 'Your systems are set up but switched off, so the pricing API is not answering.'
                  : 'The engine could not run, so a base price was served instead of a decision.'}
            </p>
          </div>
        </div>

        {/* ── what needs you ────────────────────────────────────────── */}
        {attention.length > 0 && (
          <div className={s.alerts}>
            {attention.map((a) => (
              <button
                key={a.project_id}
                type="button"
                className={s.alert}
                onClick={() => open(a.project_id)}
              >
                <span className={s.alertIcon}>
                  <Icon name="warning" size={16} />
                </span>
                <span className={s.alertText}>
                  <span className={s.alertName}>{a.name}</span>
                  <span className={s.alertWhy}>
                    {plural(a.fallbacks, 'decision')} fell back to the base price
                  </span>
                </span>
                <span className={s.alertGo}>
                  Open
                  <Icon name="arrow-right" size={13} />
                </span>
              </button>
            ))}
          </div>
        )}

        {/* ── counts, not analytics ─────────────────────────────────── */}
        <div className={s.counts}>
          <Count label="Pricing systems" value={projects.length} />
          <Count label="Switched on" value={active} tone={active > 0 ? 'on' : undefined} />
          <Count label="Switched off" value={off} />
          <Count label="Still in setup" value={drafts} />
        </div>

        <div className={s.foot}>
          <span>
            {plural(industries, 'industry', 'industries')} · {number(products)}{' '}
            {products === 1 ? 'product' : 'products'} across your account
          </span>
        </div>
      </section>

      {/* ── the systems themselves, directly under their own status ──── */}
      <ProjectGrid projects={projects} onOpen={openProject} onDelete={setDeleting} />

      {deleting && (
        <Modal
          open
          title={`Delete "${deleting.name}"?`}
          onClose={() => !removeProject.pending && setDeleting(null)}
          footer={
            <Row>
              <Button variant="ghost" onClick={() => setDeleting(null)} disabled={removeProject.pending}>
                Cancel
              </Button>
              <Button
                variant="danger"
                icon="close"
                loading={removeProject.pending}
                onClick={() => void removeProject.run(deleting.project_id)}
              >
                Delete everything
              </Button>
            </Row>
          }
        >
          <p style={{ fontSize: 'var(--t-sm)', color: 'var(--text-secondary)', lineHeight: 'var(--lh-base)' }}>
            This permanently removes the project and <strong>everything in it</strong> — its
            products, rules, strategies, limits, API key, decision history and the AI chat.
            Whether it's a draft or live, it's gone. <strong>This cannot be undone.</strong>
          </p>
        </Modal>
      )}
    </div>
  );
}

/** A fact about the account, not a measurement of it: no range, no trend. */
function Count({ label, value, tone }: { label: string; value: number; tone?: 'on' }) {
  return (
    <div className={s.count}>
      <span className={cx(s.countValue, tone && s.countOn)}>{value}</span>
      <span className={s.countLabel}>{label}</span>
    </div>
  );
}
