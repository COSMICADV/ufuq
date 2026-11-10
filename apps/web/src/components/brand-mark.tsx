/** The 1to1OS mark — the same glyph as the public home page, on a slate tile. */
export function BrandMark(): React.JSX.Element {
  return (
    <svg className="brand-mark" viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <rect
        x="0.5"
        y="0.5"
        width="39"
        height="39"
        rx="11"
        style={{ fill: 'var(--bg-surface)', stroke: 'var(--border-strong)' }}
      />
      <g
        transform="translate(8 8)"
        stroke="var(--brand-indigo)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 12h16" />
        <path d="M7 6v12" />
        <path d="M17 6v12" />
        <path d="M7 12a5 5 0 0 1 10 0" />
      </g>
    </svg>
  );
}

/** "1to1OS", set like the home page logo. Always left-to-right, in both languages. */
export function Wordmark(): React.JSX.Element {
  return (
    <span className="wordmark" dir="ltr" translate="no">
      1<span className="wordmark__to">to</span>1<span className="wordmark__os">OS</span>
    </span>
  );
}
