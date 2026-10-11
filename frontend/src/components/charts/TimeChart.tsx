import { useMemo, type ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Brush,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from 'recharts';
import type { TimeseriesResponse } from '@/api/types';
import { SkeletonBlock } from '@/components/ui/Feedback';
import { clockTime, compactNumber, dateTime, money, number } from '@/lib/format';
import s from './Chart.module.css';

/**
 * The one time-series chart component.
 *
 * Reusable on purpose: the analytics page shows eleven metrics, and eleven
 * bespoke charts would drift apart in axis formatting, tooltip wording and
 * empty-state behaviour. The variation that matters — how a value is formatted,
 * which shape suits the data — is a prop.
 *
 * Styling comes entirely from CSS variables, so charts follow the theme switch
 * like everything else rather than being hardcoded to dark.
 */

export type ChartKind = 'area' | 'line' | 'bar';
export type ValueFormat = 'money' | 'number' | 'percent' | 'ms';

export interface TimeChartProps {
  title: string;
  /** The question this chart answers, shown under the title. */
  question?: string;
  data: TimeseriesResponse | null;
  loading?: boolean;
  kind?: ChartKind;
  format?: ValueFormat;
  currency?: string | null;
  height?: number;
  /** A horizontal marker, e.g. a guardrail ceiling or a target. */
  reference?: { value: number; label: string } | null;
  /** Shown when the series has no points. Must say what to do about it. */
  emptyHint?: ReactNode;
  colorVar?: string;
  /**
   * Charts sharing a syncId share a hover position, so pointing at 14:00 on
   * Revenue highlights 14:00 on Price too. Without it each chart tracks the
   * cursor alone and comparing two series means reading timestamps by eye.
   */
  syncId?: string;
  /**
   * Adds a draggable range selector under the chart.
   *
   * Only worth it on long windows: at 30 days a point is a day and the detail is
   * invisible without zooming, whereas on a 1-hour window the brush is a strip
   * of UI that does nothing useful.
   */
  brush?: boolean;
}

function formatValue(
  value: number | null | undefined,
  format: ValueFormat,
  currency: string | null | undefined,
  compact = false,
): string {
  if (value === null || value === undefined) return '—';
  switch (format) {
    case 'money':
      return money(value, currency, { compact });
    case 'percent':
      return `${value.toFixed(value < 10 ? 1 : 0)}%`;
    case 'ms':
      return `${value.toFixed(value < 100 ? 1 : 0)} ms`;
    case 'number':
      return compact && Math.abs(value) >= 1000 ? compactNumber(value) : number(value, 0);
  }
}

export function TimeChart({
  title,
  question,
  data,
  loading,
  kind = 'area',
  format = 'number',
  currency,
  height = 220,
  reference,
  emptyHint,
  colorVar = '--chart-1',
  syncId,
  brush,
}: TimeChartProps) {
  const points = data?.points ?? [];

  // recharts wants plain objects; mapping once here keeps the render cheap when
  // a poll refetches the same shape.
  const series = useMemo(() => points.map((p) => ({ t: p.t, value: p.value })), [points]);

  const colour = `var(${colorVar})`;
  const gradientId = `grad-${colorVar.replace(/[^a-z0-9]/gi, '')}`;

  const stats = data?.stats;

  const body = (() => {
    if (loading && points.length === 0) {
      return (
        <div className={s.body}>
          <SkeletonBlock height={height} />
        </div>
      );
    }
    if (points.length === 0) {
      return (
        <div className={s.placeholder}>
          {emptyHint ?? 'No activity in this window yet.'}
        </div>
      );
    }

    const axisProps = {
      stroke: 'var(--chart-axis)',
      fontSize: 11,
      tickLine: false,
      axisLine: false,
    } as const;

    const grid = <CartesianGrid stroke="var(--chart-grid)" vertical={false} />;
    const xAxis = (
      <XAxis
        dataKey="t"
        {...axisProps}
        // Clock time only: the range selector already says which day(s) this is,
        // and a full date on every tick is unreadable at this width.
        tickFormatter={(t: number) => clockTime(t)}
        minTickGap={32}
      />
    );
    const yAxis = (
      <YAxis
        {...axisProps}
        width={52}
        tickFormatter={(v: number) => formatValue(v, format, currency, true)}
      />
    );
    const tooltip = (
      <Tooltip
        content={<ChartTooltip format={format} currency={currency} label={title} />}
        cursor={{ stroke: 'var(--border-strong)', strokeWidth: 1 }}
      />
    );
    // The brush needs room, so the chart body shrinks rather than the card growing.
    const brushEl = brush && series.length > 8 ? (
      <Brush
        dataKey="t"
        height={20}
        travellerWidth={8}
        stroke="var(--border-strong)"
        fill="var(--surface-sunken)"
        tickFormatter={() => ''}
      />
    ) : null;

    const common = { syncId, margin: { top: 8, right: 12, bottom: 0, left: 0 } };

    const refLine = reference ? (
      <ReferenceLine
        y={reference.value}
        stroke="var(--critical)"
        strokeDasharray="4 4"
        label={{
          value: reference.label,
          position: 'insideTopRight',
          fill: 'var(--critical-text)',
          fontSize: 10,
        }}
      />
    ) : null;

    return (
      <div className={s.body}>
        <ResponsiveContainer width="100%" height={height}>
          {kind === 'bar' ? (
            <BarChart data={series} {...common}>
              {grid}
              {xAxis}
              {yAxis}
              {tooltip}
              {refLine}
              <Bar dataKey="value" fill={colour} radius={[2, 2, 0, 0]} maxBarSize={28} />
            {brushEl}
            </BarChart>
          ) : kind === 'line' ? (
            <LineChart data={series} {...common}>
              {grid}
              {xAxis}
              {yAxis}
              {tooltip}
              {refLine}
              <Line
                type="monotone"
                dataKey="value"
                stroke={colour}
                strokeWidth={1.8}
                dot={false}
                // No entry animation: these charts poll, and re-animating the
                // whole line every refresh reads as a glitch.
                isAnimationActive={false}
              />
            {brushEl}
            </LineChart>
          ) : (
            <AreaChart data={series} {...common}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={colour} stopOpacity={0.22} />
                  <stop offset="100%" stopColor={colour} stopOpacity={0} />
                </linearGradient>
              </defs>
              {grid}
              {xAxis}
              {yAxis}
              {tooltip}
              {refLine}
              <Area
                type="monotone"
                dataKey="value"
                stroke={colour}
                strokeWidth={1.8}
                fill={`url(#${gradientId})`}
                isAnimationActive={false}
              />
            {brushEl}
            </AreaChart>
          )}
        </ResponsiveContainer>
      </div>
    );
  })();

  return (
    <div className={s.frame}>
      <div className={s.head}>
        <div className={s.titleBlock}>
          <div className={s.title}>{title}</div>
          {question && <div className={s.question}>{question}</div>}
        </div>
        {stats && points.length > 0 && (
          <div className={s.latest}>
            <div className={s.latestValue}>
              {formatValue(stats.latest, format, currency)}
            </div>
            {/* "latest" alone read as a total, so a ₹0 most-recent bucket sat
                next to a ₹1.02K KPI card for the same metric and looked like a
                contradiction. Name the bucket instead. */}
            <div className={s.latestLabel}>
              latest {data?.interval ?? ''} bucket
            </div>
          </div>
        )}
      </div>

      {body}

      {stats && points.length > 0 && (
        <div className={s.stats}>
          <span className={s.stat}>
            <span className={s.statKey}>avg</span>
            <span className={s.statValue}>{formatValue(stats.avg, format, currency, true)}</span>
          </span>
          <span className={s.stat}>
            <span className={s.statKey}>min</span>
            <span className={s.statValue}>{formatValue(stats.min, format, currency, true)}</span>
          </span>
          <span className={s.stat}>
            <span className={s.statKey}>max</span>
            <span className={s.statValue}>{formatValue(stats.max, format, currency, true)}</span>
          </span>
          {data?.source && (
            <span className={s.stat} style={{ marginLeft: 'auto' }}>
              <span className={s.statKey}>{data.interval} buckets</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function ChartTooltip({
  active,
  payload,
  format,
  currency,
  label,
}: TooltipProps<number, string> & {
  format: ValueFormat;
  currency: string | null | undefined;
  label: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0];
  if (!point) return null;
  const t = (point.payload as { t?: number } | undefined)?.t;

  return (
    <div className={s.tooltip}>
      <div className={s.tooltipTime}>{dateTime(t)}</div>
      <div className={s.tooltipRow}>
        <span className={s.tooltipSwatch} style={{ background: point.color ?? 'var(--chart-1)' }} />
        {label}
        <span className={s.tooltipValue} style={{ marginLeft: 'var(--s-2)' }}>
          {formatValue(point.value ?? null, format, currency)}
        </span>
      </div>
    </div>
  );
}

/**
 * A tiny inline trend, for a table cell or a card.
 *
 * No axes, no tooltip, no grid — it conveys shape only. Anything that needs a
 * readable value uses the full chart.
 */
export function Sparkline({
  points,
  colorVar = '--chart-1',
  height = 32,
}: {
  points: readonly { t: number; value: number }[];
  colorVar?: string;
  height?: number;
}) {
  if (points.length < 2) return null;
  return (
    <div className={s.spark} style={{ height }}>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={points as { t: number; value: number }[]} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <Line
            type="monotone"
            dataKey="value"
            stroke={`var(${colorVar})`}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
