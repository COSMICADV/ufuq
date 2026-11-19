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

/**
 * The product logo from the design board: "1to1OS" in navy, the product's
 * name in blue italic beside it, a brush stroke under the brand and three
 * spark lines above. Always left-to-right, in every language.
 */
export function ProductLogo({
  product,
  className,
}: {
  readonly product?: 'Business' | 'Personal';
  readonly className?: string;
}): React.JSX.Element {
  return (
    <span className={['os-logo', className].filter(Boolean).join(' ')} dir="ltr" translate="no">
      <span className="os-logo__brand">
        1to1OS
        <svg
          className="os-logo__underline"
          viewBox="0 0 100 10"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path d="M3 7C30 3.6 64 3 97 5" />
        </svg>
      </span>
      {product ? <span className="os-logo__product">{product}</span> : null}
      <svg className="os-logo__spark" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M6 9 4.6 3.4" />
        <path d="M9.6 10.6l3.6-4" />
        <path d="M11 14.2l5-1" />
      </svg>
    </span>
  );
}
