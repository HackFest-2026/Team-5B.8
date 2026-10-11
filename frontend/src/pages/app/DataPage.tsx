import { useRef, useState } from 'react';
import { dataApi, type UploadKind } from '@/api/endpoints';
import type { DataJobListResponse } from '@/api/types';
import { KeyValues, MainWithSide, Note, PageHeader, Row, Stack, Well } from '@/components/PageHeader';
import { Badge } from '@/components/ui/Badge';
import { Button, LinkButton } from '@/components/ui/Button';
import { Card, CardBody, CardHeader, Metric, MetricGrid } from '@/components/ui/Card';
import { Select } from '@/components/ui/Field';
import { EmptyState, ErrorState, Loading, Progress, SkeletonText } from '@/components/ui/Feedback';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { useAsync } from '@/hooks/useAsync';
import { useSession } from '@/hooks/useSession';
import { cx } from '@/lib/cx';
import { dateTime, number, percent } from '@/lib/format';
import s from './Data.module.css';

/**
 * Historical data upload.
 *
 * The upload is a three-step dance the UI has to get exactly right:
 *
 *   1. `/data/upload-url` returns a presigned S3 PUT and a job id.
 *   2. the browser PUTs the file straight to S3 — with NO extra headers. The
 *      signature covers only the bucket and key, so sending a Content-Type or
 *      any x-amz-meta-* header invalidates it and S3 answers a bare 403.
 *   3. a worker picks the object up and fills in the job's validation summary,
 *      so the UI polls the job rather than expecting a synchronous result.
 *
 * Calm and simple, as the spec asks — an upload box and a history, not a file
 * manager.
 */

const KINDS: { value: UploadKind; label: string }[] = [
  { value: 'items', label: 'Products to price' },
  { value: 'historical', label: 'Historical pricing and sales' },
  { value: 'competitor', label: 'Competitor prices' },
];

const ACCEPTED = '.csv,.tsv,.json,.jsonl,.xlsx,.xls';

type Job = DataJobListResponse['jobs'][number];

export default function DataPage() {
  const { project, projectId } = useSession();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  // Preselected from the link that sent the user here: arriving from Products
  // and then having to pick "products" from a dropdown is a step that exists
  // only because the screen forgot where you came from.
  const [kind, setKind] = useState<UploadKind>(() => {
    const want = new URLSearchParams(window.location.search).get('kind');
    return want === 'items' || want === 'competitor' || want === 'historical' ? want : 'items';
  });
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState<{ name: string; pct: number } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const jobs = useAsync(
    (signal) => dataApi.jobs(projectId!, 20, { signal }),
    [projectId],
    // Poll while anything is still processing; a finished list settles down.
    { enabled: !!projectId, pollMs: 8000 },
  );

  const anyProcessing = (jobs.data?.jobs ?? []).some(
    (j) => j.status === 'processing' || j.status === 'pending',
  );

  async function upload(file: File) {
    if (!projectId) return;
    setUploadError(null);
    setUploading({ name: file.name, pct: 0 });

    try {
      const ticket = await dataApi.uploadUrl(projectId, file.name, kind);

      if (file.size > ticket.max_bytes) {
        setUploadError(
          `That file is ${(file.size / 1_048_576).toFixed(1)} MB. The limit is ${(
            ticket.max_bytes / 1_048_576
          ).toFixed(0)} MB — split it and upload in parts.`,
        );
        setUploading(null);
        return;
      }

      await dataApi.upload(ticket.upload_url, file, (pct) =>
        setUploading({ name: file.name, pct }),
      );

      toast.success('Upload complete', 'Validating your file — the summary appears below shortly.');
      setSelected(ticket.job_id);
      jobs.refetch();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'The upload failed.');
    } finally {
      setUploading(null);
    }
  }

  if (!project) {
    return (
      <Card>
        <EmptyState
          icon="data"
          title="No project selected"
          body="Create a project before uploading historical data."
          action={
            <LinkButton to="/app/projects/new" variant="primary" icon="plus">
              Create a project
            </LinkButton>
          }
        />
      </Card>
    );
  }

  return (
    <Stack>
      <PageHeader
        title="Import a file"
        description="Load your products in bulk, or bring past prices and sales so a strategy can be backtested before it ever touches a customer. CSV, TSV, JSON, JSONL, XLSX and XLS are all accepted."
      />

      <MainWithSide>
        <Stack>
          {/* ── upload ─────────────────────────────────────────────────── */}
          <Card>
            <CardBody>
              <Stack>
                <Select
                  label="What is in this file?"
                  value={kind}
                  options={KINDS}
                  hint="This decides which columns DevNexus expects."
                  onChange={(e) => setKind(e.target.value as UploadKind)}
                />

                <div
                  className={cx(s.drop, dragging && s.dropActive, uploading && s.dropBusy)}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    const file = e.dataTransfer.files?.[0];
                    if (file) void upload(file);
                  }}
                >
                  {uploading ? (
                    <div style={{ width: '100%' }}>
                      <Progress
                        value={uploading.pct}
                        label={`Uploading ${uploading.name} — ${Math.round(uploading.pct)}%`}
                      />
                    </div>
                  ) : (
                    <>
                      <Icon name="upload" size={26} className={s.dropIcon} />
                      <div className={s.dropTitle}>Drop a file here</div>
                      <div className={s.dropHint}>or choose one from your computer</div>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => inputRef.current?.click()}
                      >
                        Choose a file
                      </Button>
                      <input
                        ref={inputRef}
                        type="file"
                        accept={ACCEPTED}
                        className="sr-only"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void upload(file);
                          // Reset so choosing the same file twice fires again.
                          e.target.value = '';
                        }}
                      />
                    </>
                  )}
                </div>

                {uploadError && (
                  <ErrorState
                    error={new Error(uploadError)}
                    title="The upload did not go through"
                  />
                )}

                <div className={s.steps}>
                  {['Upload', 'Validate', 'Process', 'Ready'].map((step, i) => (
                    <div key={step} className={s.step}>
                      <span className={s.stepNum}>{i + 1}</span>
                      {step}
                      {i < 3 && <span className={s.stepArrow}>→</span>}
                    </div>
                  ))}
                </div>
              </Stack>
            </CardBody>
          </Card>

          {/* ── history ────────────────────────────────────────────────── */}
          <Card>
            <CardHeader
              title="Uploads"
              subtitle={anyProcessing ? 'A file is still being processed.' : undefined}
              actions={
                <Button size="sm" variant="ghost" icon="refresh" aria-label="Refresh" onClick={jobs.refetch} />
              }
            />
            {jobs.initialLoading ? (
              <Loading label="Loading upload history" />
            ) : (jobs.data?.jobs ?? []).length === 0 ? (
              <EmptyState
                icon="data"
                title="No historical data yet"
                body="Upload historical data to start backtesting. Without it, you can still use what-if simulation and shadow mode."
                action={
                  <LinkButton to="/app/simulation" variant="secondary" size="sm">
                    Try what-if instead
                  </LinkButton>
                }
              />
            ) : (
              <CardBody tight>
                <Stack tight>
                  {(jobs.data?.jobs ?? []).map((job) => (
                    <JobRow
                      key={job.job_id}
                      job={job}
                      selected={selected === job.job_id}
                      onSelect={() => setSelected(job.job_id)}
                    />
                  ))}
                </Stack>
              </CardBody>
            )}
          </Card>
        </Stack>

        {/* ── detail ───────────────────────────────────────────────────── */}
        <div>
          {selected ? (
            <JobDetail projectId={projectId!} jobId={selected} onClose={() => setSelected(null)} />
          ) : (
            <Card>
              <CardHeader title="Validation detail" />
              <CardBody>
                <Note>
                  Select an upload to see how many rows were accepted, which were rejected and why,
                  and to download the rejected rows for fixing.
                </Note>
              </CardBody>
            </Card>
          )}
        </div>
      </MainWithSide>
    </Stack>
  );
}

function JobRow({
  job,
  selected,
  onSelect,
}: {
  job: Job;
  selected: boolean;
  onSelect: () => void;
}) {
  const tone =
    job.status === 'completed' ? 'success' : job.status === 'failed' ? 'critical' : 'warning';

  return (
    <button type="button" className={cx(s.jobRow, selected && s.jobRowActive)} onClick={onSelect}>
      <span className={s.jobIcon}>
        <Icon name={job.status === 'completed' ? 'check' : job.status === 'failed' ? 'warning' : 'spinner'} size={14} />
      </span>
      <span className={s.jobText}>
        <span className={s.jobName}>{job.filename}</span>
        <span className={s.jobMeta}>
          {job.kind} · {dateTime(job.created_at)}
        </span>
      </span>
      <span className={s.jobStats}>
        <Badge tone={tone}>{job.status}</Badge>
        {job.rows_total > 0 && (
          <span className={s.jobRows}>
            {number(job.rows_valid)} of {number(job.rows_total)} rows
          </span>
        )}
      </span>
    </button>
  );
}

function JobDetail({
  projectId,
  jobId,
  onClose,
}: {
  projectId: string;
  jobId: string;
  onClose: () => void;
}) {
  const detail = useAsync(
    (signal) => dataApi.job(projectId, jobId, { signal }),
    [projectId, jobId],
    { pollMs: 5000 },
  );

  const d = detail.data;
  const processing = d?.status === 'processing' || d?.status === 'pending';

  return (
    <Stack>
      <Card>
        <CardHeader
          title={d?.filename ?? 'Upload'}
          subtitle={d ? `${d.kind} · ${dateTime(d.created_at)}` : undefined}
          actions={<Button size="sm" variant="ghost" icon="close" aria-label="Close" onClick={onClose} />}
        />
        <CardBody>
          {detail.initialLoading ? (
            <SkeletonText lines={4} />
          ) : detail.error ? (
            <ErrorState error={detail.error} onRetry={detail.refetch} />
          ) : processing ? (
            <Loading label={`Processing ${number(d?.summary?.rows_total ?? 0)} rows…`} />
          ) : d?.status === 'failed' ? (
            <ErrorState
              error={new Error(d.error ?? 'The file could not be processed.')}
              title="This upload failed"
            />
          ) : d ? (
            <Stack>
              <MetricGrid>
                <Metric label="Rows accepted" value={number(d.summary.rows_valid)} />
                <Metric
                  label="Rows rejected"
                  value={number(d.summary.rows_invalid)}
                  foot={d.summary.rows_invalid > 0 ? 'downloadable below' : undefined}
                />
                <Metric label="Warnings" value={number(d.summary.rows_warned)} />
                <Metric
                  label="Quality"
                  value={percent(d.summary.quality_pct)}
                  foot={`${number(d.items_affected)} items affected`}
                />
              </MetricGrid>

              {d.rejected_rows_url && (
                <Well>
                  <Row>
                    <Icon name="download" size={15} style={{ color: 'var(--warning-text)' }} />
                    <strong style={{ fontSize: 'var(--t-sm)' }}>
                      {number(d.summary.rows_invalid)} rows were rejected
                    </strong>
                  </Row>
                  <p
                    style={{
                      marginTop: 'var(--s-2)',
                      fontSize: 'var(--t-sm)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    Download them, fix the problems, and upload just those rows again.
                  </p>
                  <div style={{ marginTop: 'var(--s-3)' }}>
                    <a
                      href={d.rejected_rows_url}
                      // A presigned S3 link: it must not carry a referrer, and it
                      // should download rather than navigate the app away.
                      rel="noopener noreferrer"
                      target="_blank"
                      download
                    >
                      <Button size="sm" variant="secondary" icon="download">
                        Download rejected rows
                      </Button>
                    </a>
                  </div>
                </Well>
              )}

              {Object.keys(d.errors_by_type ?? {}).length > 0 && (
                <div>
                  <strong style={{ fontSize: 'var(--t-sm)' }}>Why rows were rejected</strong>
                  <div style={{ marginTop: 'var(--s-2)' }}>
                    <KeyValues
                      rows={Object.entries(d.errors_by_type).map(([k, v]) => ({
                        key: k.replace(/_/g, ' '),
                        value: `${number(v)} rows`,
                      }))}
                    />
                  </div>
                </div>
              )}

              {(d.unknown_columns as string[] | null)?.length ? (
                <Note>
                  <strong>Columns DevNexus did not recognise:</strong>{' '}
                  {(d.unknown_columns as string[]).join(', ')}. These were ignored — rename them to
                  match your schema if they matter.
                </Note>
              ) : null}

              {(d.sample_errors as string[] | null)?.length ? (
                <Well>
                  <strong style={{ fontSize: 'var(--t-sm)' }}>Example problems</strong>
                  <ul
                    style={{
                      marginTop: 'var(--s-2)',
                      fontSize: 'var(--t-xs)',
                      color: 'var(--text-secondary)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 'var(--s-1)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {(d.sample_errors as unknown[]).slice(0, 6).map((e, i) => (
                      <li key={i}>· {typeof e === 'string' ? e : JSON.stringify(e)}</li>
                    ))}
                  </ul>
                </Well>
              ) : null}

              {d.summary.rows_valid > 0 && (
                <Row>
                  <LinkButton to="/app/simulation" variant="primary" size="sm" iconAfter="arrow-right">
                    Backtest with this data
                  </LinkButton>
                </Row>
              )}
            </Stack>
          ) : null}
        </CardBody>
      </Card>
    </Stack>
  );
}
