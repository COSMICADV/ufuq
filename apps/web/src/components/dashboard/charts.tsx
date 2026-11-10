/**
 * Small chart pieces for the dashboards, drawn with HTML and CSS so they
 * follow the page direction (RTL in Arabic) and every colour theme without a
 * charting library. Each chart carries a legend when it has more than one
 * series, a hover/focus tooltip per mark, and a visually hidden table with the
 * same figures for screen readers.
 */

import type { ReactNode } from 'react';

export interface Series {
  readonly key: string;
  readonly label: string;
  /** A CSS colour, normally a token: `var(--semantic-success)`. */
  readonly color: string;
}

export function Legend({ series }: { readonly series: readonly Series[] }): React.JSX.Element {
  return (
    <ul className="chart-legend">
      {series.map((s) => (
        <li key={s.key}>
          <span className="chart-swatch" style={{ background: s.color }} aria-hidden="true" />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/** Round a maximum up to a tidy axis top (1, 2, 5 × 10ⁿ), at least 4. */
export function niceMax(value: number): number {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * magnitude >= value) return step * magnitude;
  }
  return 10 * magnitude;
}

export interface Column {
  readonly key: string;
  /** Under the column (thinned when there are many). */
  readonly label: string;
  /** Tooltip heading. */
  readonly title: string;
  readonly values: Readonly<Record<string, number>>;
  /** Extra tooltip lines that are not stacked (e.g. "of which late"). */
  readonly notes?: readonly { readonly label: string; readonly value: string }[];
}

/**
 * Stacked columns over a sequence (days, months). Series stack from the
 * baseline in the order given.
 */
export function StackedColumns({
  series,
  columns,
  caption,
  format,
  emptyText,
}: {
  readonly series: readonly Series[];
  readonly columns: readonly Column[];
  readonly caption: string;
  readonly format: (value: number) => string;
  readonly emptyText: string;
}): React.JSX.Element {
  const totals = columns.map((c) => series.reduce((sum, s) => sum + (c.values[s.key] ?? 0), 0));
  const top = niceMax(Math.max(0, ...totals));
  const ticks = [top, (top * 3) / 4, top / 2, top / 4, 0];
  const every = Math.max(1, Math.ceil(columns.length / 8));
  const empty = totals.every((total) => total === 0);

  return (
    <figure className="chart">
      <Legend series={series} />
      <div className="chart-plot" aria-hidden="true">
        <div className="chart-axis">
          {ticks.map((tick) => (
            <span key={tick}>{format(tick)}</span>
          ))}
        </div>
        <div className="chart-area">
          <div className="chart-grid">
            {ticks.map((tick) => (
              <span key={tick} />
            ))}
          </div>
          {empty ? <p className="chart-empty">{emptyText}</p> : null}
          <div className="chart-columns" style={{ ['--columns' as string]: columns.length }}>
            {columns.map((column, index) => {
              const total = totals[index] ?? 0;
              const edge =
                index < columns.length / 5
                  ? 'start'
                  : index >= (columns.length * 4) / 5
                    ? 'end'
                    : 'mid';
              return (
                <div key={column.key} className="chart-col" tabIndex={-1}>
                  <div className="chart-stack" style={{ blockSize: `${(total / top) * 100}%` }}>
                    {series.map((s) =>
                      (column.values[s.key] ?? 0) > 0 ? (
                        <span
                          key={s.key}
                          style={{ flexGrow: column.values[s.key], background: s.color }}
                        />
                      ) : null,
                    )}
                  </div>
                  <div className={`chart-tip chart-tip--${edge}`}>
                    <strong>{column.title}</strong>
                    {series.map((s) => (
                      <span key={s.key} className="chart-tip__row">
                        <span className="chart-swatch" style={{ background: s.color }} />
                        <span>{s.label}</span>
                        <b>{format(column.values[s.key] ?? 0)}</b>
                      </span>
                    ))}
                    {column.notes?.map((note) => (
                      <span key={note.label} className="chart-tip__row chart-tip__row--note">
                        <span />
                        <span>{note.label}</span>
                        <b>{note.value}</b>
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div
        className="chart-xlabels"
        aria-hidden="true"
        style={{ ['--columns' as string]: columns.length }}
      >
        {columns.map((column, index) => (
          <span key={column.key}>{index % every === 0 ? column.label : ''}</span>
        ))}
      </div>
      <DataTable
        caption={caption}
        head={['', ...series.map((s) => s.label)]}
        rows={columns.map((c) => [c.title, ...series.map((s) => format(c.values[s.key] ?? 0))])}
      />
    </figure>
  );
}

export interface Bar {
  readonly key: string;
  readonly label: ReactNode;
  readonly value: number;
  readonly display: string;
  readonly color?: string;
  /** A second, inner portion of the bar (e.g. completed out of assigned). */
  readonly part?: { readonly value: number; readonly color: string };
}

/** Horizontal bars with the value at the end — counts or percentages. */
export function BarList({
  bars,
  max,
  caption,
  series,
}: {
  readonly bars: readonly Bar[];
  /** The full-length value; defaults to the largest bar. */
  readonly max?: number;
  readonly caption: string;
  /** A legend, when bars carry an inner part. */
  readonly series?: readonly Series[];
}): React.JSX.Element {
  const top = max ?? Math.max(1, ...bars.map((bar) => bar.value));
  return (
    <figure className="chart">
      {series === undefined ? null : <Legend series={series} />}
      <ul className="bar-list" aria-hidden="true">
        {bars.map((bar) => (
          <li key={bar.key}>
            <span className="bar-list__label">{bar.label}</span>
            <span className="bar-list__track">
              <span
                className="bar-list__fill"
                style={{
                  inlineSize: `${Math.min(100, (bar.value / top) * 100)}%`,
                  background: bar.color ?? 'var(--chart-1)',
                }}
              >
                {bar.part === undefined || bar.value === 0 ? null : (
                  <span
                    className="bar-list__part"
                    style={{
                      inlineSize: `${Math.min(100, (bar.part.value / bar.value) * 100)}%`,
                      background: bar.part.color,
                    }}
                  />
                )}
              </span>
            </span>
            <span className="bar-list__value">{bar.display}</span>
          </li>
        ))}
      </ul>
      <DataTable
        caption={caption}
        head={['', '']}
        rows={bars.map((bar) => [typeof bar.label === 'string' ? bar.label : bar.key, bar.display])}
      />
    </figure>
  );
}

/** A single rate as a ring, with the figure in the middle. */
export function RateRing({
  value,
  display,
  color = 'var(--brand-indigo)',
  size = 84,
}: {
  readonly value: number | null;
  readonly display: string;
  readonly color?: string;
  readonly size?: number;
}): React.JSX.Element {
  const stroke = 8;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = value === null ? 0 : (Math.max(0, Math.min(100, value)) / 100) * circumference;
  return (
    <span className="rate-ring" style={{ inlineSize: size, blockSize: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--chart-track)"
          strokeWidth={stroke}
        />
        {filled === 0 ? null : (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${filled} ${circumference}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      <span className="rate-ring__value">{display}</span>
    </span>
  );
}

/** A headline figure with a ring, for the KPI row. */
export function RateTile({
  label,
  value,
  display,
  hint,
  color,
}: {
  readonly label: string;
  readonly value: number | null;
  readonly display: string;
  readonly hint: string;
  readonly color?: string;
}): React.JSX.Element {
  return (
    <section className="card rate-tile">
      <RateRing value={value} display={display} {...(color === undefined ? {} : { color })} />
      <div>
        <h3 className="rate-tile__label">{label}</h3>
        <p className="rate-tile__hint">{hint}</p>
      </div>
    </section>
  );
}

function DataTable({
  caption,
  head,
  rows,
}: {
  readonly caption: string;
  readonly head: readonly string[];
  readonly rows: readonly (readonly string[])[];
}): React.JSX.Element {
  return (
    <table className="visually-hidden">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {head.map((cell, index) => (
            <th key={index} scope="col">
              {cell}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={index}>
            {row.map((cell, cellIndex) =>
              cellIndex === 0 ? (
                <th key={cellIndex} scope="row">
                  {cell}
                </th>
              ) : (
                <td key={cellIndex}>{cell}</td>
              ),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
