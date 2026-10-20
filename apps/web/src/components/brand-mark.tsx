export function BrandMark(): React.JSX.Element {
  return (
    <svg className="brand-mark" viewBox="0 0 48 32" fill="none" aria-hidden="true">
      <path
        d="m3 24 13-13 8 7L33 7l12 17"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m14 28 8-8m7 0 8 8"
        stroke="var(--brand-amber)"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
