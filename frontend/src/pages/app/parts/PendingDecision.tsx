import { useState } from 'react';
import { approvalsApi } from '@/api/endpoints';
import type { PendingApprovalsResponse } from '@/api/types';
import { Badge, SeverityBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/Feedback';
import { Icon } from '@/components/ui/Icon';
import { ConfirmDialog } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { useApprovals } from '@/hooks/useApprovals';
import { useMutation } from '@/hooks/useAsync';
import { cx } from '@/lib/cx';
import { duration, relativeTime } from '@/lib/format';
import s from './PendingDecision.module.css';

type Approval = PendingApprovalsResponse['approvals'][number];
type Option = Approval['options'][number];

/**
 * A decision the platform is waiting on a human to make.
 *
 * This is the notification → question → options → answer flow. Two things are
 * load-bearing:
 *
 *  1. `/approvals/answer` RECORDS the choice AND EXECUTES it. Answering with
 *     "Roll back to v2" actually rolls back. So an option that changes live
 *     pricing is confirmed before the call, never after — there is no undo on
 *     the far side of that request.
 *
 *  2. Each option's consequence is shown on screen, not on hover. The user is
 *     choosing between outcomes and needs to read them to choose.
 */

/**
 * Which actions change what live traffic is priced with.
 *
 * Matched against the server's fixed action whitelist. Anything unrecognised is
 * treated as SAFE rather than dangerous — deliberately: a false "are you sure?"
 * on a harmless option trains people to click through confirmations, which is
 * exactly how a real rollback gets confirmed without being read.
 */
const DESTRUCTIVE_ACTIONS = new Set(['rollback', 'pause', 'safe_mode', 'activate', 'promote']);

function isDestructive(option: Option): boolean {
  return DESTRUCTIVE_ACTIONS.has((option.action ?? '').toLowerCase());
}

export function PendingDecision({
  approvals,
  onAnswered,
}: {
  approvals: readonly Approval[];
  onAnswered: () => void;
}) {
  const toast = useToast();
  const { dismiss } = useApprovals();
  const [index, setIndex] = useState(0);
  const [confirming, setConfirming] = useState<Option | null>(null);

  const approval = approvals[Math.min(index, approvals.length - 1)];

  const answer = useMutation(
    (approvalId: string, optionId: string) => approvalsApi.answer(approvalId, optionId),
    {
      onSuccess: () => {
        setConfirming(null);
        toast.success('Decision recorded', 'DevNexus has carried out your choice.');
        // Move to the next question if there is one, so answering a queue does
        // not bounce the user back to the start each time.
        setIndex((i) => (i + 1 < approvals.length ? i : 0));
        onAnswered();
      },
    },
  );

  if (!approval) return null;

  /**
   * Answer, then remove the card immediately.
   *
   * `/approvals/answer` records AND executes, so by the time it returns the
   * rollback (or pause) has already happened. Leaving the question on screen
   * until the next poll makes a completed action look like it did not register.
   *
   * The removal happens AFTER success, never before: this is irreversible, and
   * optimistically hiding a question whose request might still fail would leave
   * the user believing a rollback happened that did not.
   */
  const submit = async (approvalId: string, optionId: string) => {
    const result = await answer.run(approvalId, optionId);
    if (result) dismiss(approvalId);
  };

  const choose = (option: Option) => {
    if (isDestructive(option)) {
      setConfirming(option);
      return;
    }
    void submit(approval.approval_id, option.option_id);
  };

  const severity = (approval.severity ?? 'warning').toLowerCase();

  return (
    <>
      <div className={cx(s.card, severity !== 'critical' && s.cardWarning)}>
        <div className={s.head}>
          <Icon
            name={severity === 'critical' ? 'critical' : 'warning'}
            size={19}
            className={s.headIcon}
          />
          <div className={s.headText}>
            <div className={s.question}>{approval.question}</div>
            {approval.context_summary && (
              <div className={s.context}>{approval.context_summary}</div>
            )}
            <div className={s.meta}>
              <span className={s.metaItem}>
                <SeverityBadge severity={severity} />
              </span>
              {approval.item_id && (
                <span className={s.metaItem}>
                  Item <span className={s.metaValue}>{approval.item_id}</span>
                </span>
              )}
              {approval.strategy_version && (
                <span className={s.metaItem}>
                  Strategy <span className={s.metaValue}>{approval.strategy_version}</span>
                </span>
              )}
              <span className={s.metaItem}>
                Raised <span className={s.metaValue}>{relativeTime(approval.created_at)}</span>
              </span>
              {/* An expired approval is still answerable, but saying "expires in
                  0.0s" is worse than saying nothing — it reads as a countdown
                  that has stalled rather than a deadline already passed. */}
              {approval.expires_at > 0 &&
                (approval.expires_at > Date.now() ? (
                  <span className={s.metaItem}>
                    Expires in{' '}
                    <span className={s.metaValue}>
                      {duration((approval.expires_at - Date.now()) / 1000)}
                    </span>
                  </span>
                ) : (
                  <span className={s.metaItem}>
                    <Badge tone="neutral">Expired {relativeTime(approval.expires_at)}</Badge>
                  </span>
                ))}
            </div>
          </div>

          {approvals.length > 1 && (
            <div className={s.pager}>
              <Button
                size="sm"
                variant="ghost"
                icon="chevron-left"
                aria-label="Previous question"
                disabled={index === 0}
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
              />
              {index + 1} / {approvals.length}
              <Button
                size="sm"
                variant="ghost"
                icon="chevron-right"
                aria-label="Next question"
                disabled={index >= approvals.length - 1}
                onClick={() => setIndex((i) => Math.min(approvals.length - 1, i + 1))}
              />
            </div>
          )}
        </div>

        <div className={s.body}>
          <div className={s.prompt}>What should DevNexus do?</div>
          <div className={s.options}>
            {approval.options.map((option) => {
              const danger = isDestructive(option);
              return (
                <button
                  key={option.option_id}
                  type="button"
                  className={cx(s.option, danger && s.optionDanger)}
                  disabled={answer.pending}
                  onClick={() => choose(option)}
                >
                  <span className={s.optionText}>
                    <span className={s.optionLabel}>{option.label}</span>
                    {option.consequence && (
                      <span className={s.optionConsequence}>{option.consequence}</span>
                    )}
                  </span>
                  {option.recommended && <span className={s.recommended}>recommended</span>}
                  <Icon
                    name={danger ? 'warning' : 'arrow-right'}
                    size={14}
                    style={{ color: danger ? 'var(--critical-text)' : 'var(--text-muted)' }}
                  />
                </button>
              );
            })}
          </div>

          {answer.error && (
            <div style={{ marginTop: 'var(--s-4)' }}>
              <ErrorState error={answer.error} title="Could not record your decision" />
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!confirming}
        onClose={() => {
          setConfirming(null);
          answer.reset();
        }}
        onConfirm={() => {
          if (confirming) void submit(approval.approval_id, confirming.option_id);
        }}
        title={confirming?.label ?? 'Confirm'}
        body={
          <>
            {confirming?.consequence ??
              'This will change how this project prices from the next request onwards.'}
          </>
        }
        consequence="This takes effect immediately on live traffic. There is no undo — you would have to make another change to reverse it."
        details={[
          { label: 'Project', value: approval.project_id },
          ...(approval.item_id ? [{ label: 'Item', value: approval.item_id }] : []),
          ...(approval.strategy_version
            ? [{ label: 'Current version', value: approval.strategy_version }]
            : []),
        ]}
        confirmLabel={confirming?.label ?? 'Confirm'}
        pending={answer.pending}
        error={answer.error}
      />
    </>
  );
}
