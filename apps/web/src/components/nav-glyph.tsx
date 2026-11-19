/**
 * The workspace's section icons — the approved sidebar set: a navy outline, a
 * pale blue fill inside the shape, and one solid blue detail that says what the
 * section is (the bars of a report, the tick on a clock, the tape on a box).
 *
 * Drawn on a 24-unit grid with round joins. Three CSS variables colour them, so
 * the selected item and the dark theme can recolour without redrawing:
 *
 *   --glyph-ink     the outline (default: the theme's navy)
 *   --glyph-fill    the pale fill
 *   --glyph-accent  the blue detail (default: the theme's accent)
 *
 * Decorative: always `aria-hidden`, the label is the text beside it.
 */

const INK = 'var(--glyph-ink, #0B1F4D)';
const FILL = 'var(--glyph-fill, #E3EEFF)';
const ACCENT = 'var(--glyph-accent, #0785FF)';
const PAPER = 'var(--glyph-paper, #FFFFFF)';

/** A gear outline: eight teeth around a ring, as one closed path. */
const GEAR = ((): string => {
  const teeth = 8;
  const outer = 9.6;
  const inner = 7.4;
  const points: string[] = [];
  for (let i = 0; i < teeth; i += 1) {
    const base = (i / teeth) * Math.PI * 2;
    const step = (Math.PI * 2) / teeth;
    for (const [angle, radius] of [
      [base - step * 0.32, inner],
      [base - step * 0.18, outer],
      [base + step * 0.18, outer],
      [base + step * 0.32, inner],
    ] as const) {
      points.push(`${12 + Math.cos(angle) * radius} ${12 + Math.sin(angle) * radius}`);
    }
  }
  return `M${points.join('L')}Z`;
})();

const GLYPHS = {
  overview: (
    <>
      <path
        d="M3.5 11 12 4l8.5 7v8.5c0 .9-.6 1.5-1.5 1.5H5c-.9 0-1.5-.6-1.5-1.5Z"
        fill={FILL}
        stroke={INK}
      />
      <rect x="7.6" y="14.6" width="2.2" height="3.6" rx=".7" fill={ACCENT} />
      <rect x="10.9" y="12.4" width="2.2" height="5.8" rx=".7" fill={ACCENT} />
      <rect x="14.2" y="10.2" width="2.2" height="8" rx=".7" fill={ACCENT} />
    </>
  ),
  employees: (
    <>
      <path d="M11 6.6V5.2c0-.7.5-1.2 1.2-1.2h3.6c.7 0 1.2.5 1.2 1.2v1.4" stroke={INK} />
      <rect x="9" y="6.6" width="12" height="10" rx="2" fill={FILL} stroke={INK} />
      <path d="M6.2 10.4V9.2c0-.6.4-1 1-1h2.6c.6 0 1 .4 1 1v1.2" stroke={ACCENT} />
      <rect x="3" y="10.4" width="11" height="10" rx="2.2" fill={ACCENT} stroke={ACCENT} />
      <circle cx="8.5" cy="14.3" r="1.7" fill={PAPER} stroke="none" />
      <path d="M5.8 18.6c.4-1.5 1.4-2.3 2.7-2.3s2.3.8 2.7 2.3" stroke={PAPER} />
    </>
  ),
  attendance: (
    <>
      <circle cx="11" cy="11.5" r="7.8" fill={FILL} stroke={INK} />
      <path d="M11 7.4v4.4h3.2" stroke={INK} />
      <circle cx="17.6" cy="17.6" r="4.1" fill={ACCENT} stroke={PAPER} strokeWidth="1.6" />
      <path d="M15.8 17.7l1.2 1.2 2.4-2.6" stroke={PAPER} strokeWidth="1.6" />
    </>
  ),
  tasks: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="3" fill={FILL} stroke={INK} />
      <path d="M6.6 9.7l1.3 1.3 2.2-2.4M6.6 14.7l1.3 1.3 2.2-2.4" stroke={ACCENT} />
      <path d="M12.6 9.9h5M12.6 14.9h5" stroke={INK} />
    </>
  ),
  goals: (
    <>
      <circle cx="11" cy="13" r="8" fill={FILL} stroke={INK} />
      <circle cx="11" cy="13" r="4.4" stroke={INK} />
      <circle cx="11" cy="13" r="1.4" fill={INK} stroke="none" />
      <path d="M11 13 19.2 4.8" stroke={ACCENT} />
      <path
        d="M17 3.6l2.2 1.2 1.2 2.2 1.8-1.8-1.2-2.2-2.2-1.2Z"
        fill={ACCENT}
        stroke={ACCENT}
        strokeWidth="1.2"
      />
    </>
  ),
  requests: (
    <>
      <rect x="6.2" y="3.4" width="11.6" height="9.4" rx="1.6" fill={PAPER} stroke={ACCENT} />
      <path d="M6.6 4.4 12 8.6l5.4-4.2" stroke={ACCENT} />
      <path d="M12 9.2v3.8M10.4 11.6 12 13.2l1.6-1.6" stroke={ACCENT} />
      <path
        d="M3 13.6V18c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-4.4h-5.1a3.9 3.9 0 0 1-7.8 0Z"
        fill={FILL}
        stroke={INK}
      />
    </>
  ),
  leave: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.6" fill={FILL} stroke={INK} />
      <path d="M8 3v4M16 3v4M3.5 9.6h17" stroke={INK} />
      <g fill={ACCENT} stroke="none">
        <rect x="6.6" y="12.2" width="2.4" height="2.2" rx=".6" opacity=".45" />
        <rect x="10.8" y="12.2" width="2.4" height="2.2" rx=".6" opacity=".45" />
        <rect x="15" y="12.2" width="2.4" height="2.2" rx=".6" opacity=".45" />
        <rect x="6.6" y="16" width="2.4" height="2.2" rx=".6" opacity=".45" />
        <rect x="10.8" y="16" width="2.4" height="2.2" rx=".6" opacity=".45" />
        <rect x="15" y="16" width="2.4" height="2.2" rx=".6" />
      </g>
    </>
  ),
  payroll: (
    <>
      <path d="M5.4 9 15.6 4.5c.7-.3 1.4 0 1.7.7l1.6 3.8" fill={ACCENT} stroke={INK} />
      <circle cx="11" cy="7.6" r="1.1" fill={PAPER} stroke="none" />
      <circle cx="15.2" cy="6.4" r="1" fill={PAPER} stroke="none" />
      <rect x="3" y="8.8" width="18" height="11.4" rx="2.6" fill={FILL} stroke={INK} />
      <path d="M21 12.6h-3.4a1.9 1.9 0 0 0 0 3.8H21" stroke={INK} />
      <circle cx="17.6" cy="14.5" r=".9" fill={ACCENT} stroke="none" />
    </>
  ),
  reports: (
    <>
      <path
        d="M7 3h7l4.5 4.5v12c0 .9-.6 1.5-1.5 1.5H7c-.9 0-1.5-.6-1.5-1.5v-15C5.5 3.6 6.1 3 7 3Z"
        fill={FILL}
        stroke={INK}
      />
      <path d="M14 3v4.5h4.5Z" fill={ACCENT} stroke={INK} />
      <rect x="8" y="14.6" width="2.1" height="3.6" rx=".6" fill={ACCENT} stroke="none" />
      <rect x="11.1" y="12.6" width="2.1" height="5.6" rx=".6" fill={ACCENT} stroke="none" />
      <rect x="14.2" y="10.6" width="2.1" height="7.6" rx=".6" fill={ACCENT} stroke="none" />
    </>
  ),
  warehouse: (
    <>
      <path
        d="M2.8 10 12 4.4l9.2 5.6v9c0 .9-.6 1.5-1.5 1.5H4.3c-.9 0-1.5-.6-1.5-1.5Z"
        fill={FILL}
        stroke={INK}
      />
      <rect x="7" y="12.4" width="10" height="8.1" rx=".8" fill={PAPER} stroke={INK} />
      <path d="M8.2 14.6h7.6M8.2 16.8h7.6M8.2 19h7.6" stroke={ACCENT} strokeWidth="1.5" />
    </>
  ),
  inventory: (
    <>
      <path d="M12 3 20 7.5v9L12 21l-8-4.5v-9Z" fill={FILL} stroke={INK} />
      <path d="M4 7.5 12 12l8-4.5M12 12v9" stroke={INK} />
      <path
        d="M7.6 5.3 15.8 9.8v3.4l-2.6 1.4v-3.3L5.2 6.6Z"
        fill={ACCENT}
        stroke={ACCENT}
        strokeWidth="1.2"
      />
    </>
  ),
  notifications: (
    <>
      <path
        d="M6 10.2a6 6 0 0 1 12 0c0 4.4 1.5 6 2 6.8H4c.5-.8 2-2.4 2-6.8Z"
        fill={FILL}
        stroke={INK}
      />
      <path d="M10 19.6a2 2 0 0 0 4 0" stroke={INK} />
      <circle cx="18.2" cy="5.6" r="3.1" fill={ACCENT} stroke={PAPER} strokeWidth="1.4" />
    </>
  ),
  settings: (
    <>
      <path d={GEAR} fill={FILL} stroke={INK} />
      <circle cx="12" cy="12" r="3.2" fill={PAPER} stroke={INK} />
    </>
  ),
} as const;

export type NavGlyphName = keyof typeof GLYPHS;

export function NavGlyph({
  name,
  size = 24,
  className,
}: {
  readonly name: NavGlyphName;
  readonly size?: number;
  readonly className?: string | undefined;
}): React.JSX.Element {
  return (
    <svg
      className={['glyph', className].filter(Boolean).join(' ')}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {GLYPHS[name]}
    </svg>
  );
}
