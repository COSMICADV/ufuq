/**
 * Illustrations for the 1to1OS Business page, drawn for the project in the same
 * hand-drawn style of the product pictures: navy ink with round caps, a light blue hatching,
 * and a brighter blue for the detail that carries the meaning.
 *
 * - `SectionArt`: one picture per section of the subscription, all on the same
 *   canvas so they read at one size.
 *
 * (The open work case at the top of the page is the approved illustration
 * itself, served as an image: `public/brand/business-open-case.webp`.)
 *
 * Colours come from the same CSS variables as the product art (`--art-ink`,
 * `--art-blue`, `--art-sky`, `--art-paper`), with the brand values as defaults.
 * Decorative: the text beside each one is its label.
 */

const INK = 'var(--art-ink, #0B214A)';
const BLUE = 'var(--art-blue, #0785FF)';
const SKY = 'var(--art-sky, #DDF1FF)';
const PAPER = 'var(--art-paper, #FFFFFF)';

type Props = { readonly className?: string | undefined };

function cx(...names: readonly (string | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}

/** Short parallel strokes for the light shading, inside the box given. */
function hatch(x: number, y: number, w: number, h: number, gap = 9): string {
  let d = '';
  for (let i = -h; i < w; i += gap) {
    const x1 = x + Math.max(i, 0);
    const y1 = y + h - Math.max(-i, 0);
    const run = Math.min(w - Math.max(i, 0), h - Math.max(-i, 0));
    d += `M${x1} ${y1}l${run * 0.92} ${-run * 0.92}`;
  }
  return d;
}

/** A badge on a lanyard: clip, a person, two lines. Drawn around its own origin. */
function Badge({
  x,
  y,
  tilt,
}: {
  readonly x: number;
  readonly y: number;
  readonly tilt: number;
}): React.JSX.Element {
  return (
    <g transform={`translate(${x} ${y}) rotate(${tilt})`}>
      <path d="M-14-74 0-36M14-74 0-36" stroke={BLUE} strokeWidth="7" />
      <path
        d="M-26-30c17-1.4 35-1.4 52 .2 2.6.3 4.2 2 4.4 4.8.8 20 .8 41-.2 61-.2 2.8-1.8 4.4-4.6 4.6-17 1.2-34.6 1.2-51.6 0-2.8-.2-4.4-1.8-4.6-4.6-.9-20-.9-40.6.2-60.8.2-2.8 1.8-4.6 4.4-5.2Z"
        fill={PAPER}
        stroke={INK}
        strokeWidth="3.6"
      />
      <path
        d="M-7-38c4.6-.4 9.4-.4 14 0 .4 3.4.4 6.6 0 9.6-4.6.4-9.4.4-14 0-.4-3-.4-6.2 0-9.6Z"
        fill={PAPER}
        stroke={INK}
        strokeWidth="3.2"
      />
      <path d={hatch(-14, -6, 28, 16, 6)} stroke={SKY} strokeWidth="2.4" />
      <path
        d="M0-19.4c-4.6 0-7.6 3.4-7.6 7.4s3.2 7.2 7.6 7.2 7.6-3.2 7.6-7.2c0-3.8-2.8-7-6.8-7.4"
        stroke={INK}
        strokeWidth="3.2"
      />
      <path d="M-15 9.6c1.4-7.4 7-11.6 15-11.6s13.6 4.4 15 11.6" stroke={INK} strokeWidth="3.2" />
      <path
        d="M-15 20.4c10-.6 20-.6 30 0M-11 28.6c7.4-.4 14.6-.4 22 0"
        stroke={INK}
        strokeWidth="3"
      />
    </g>
  );
}

/** A box with its top face showing and a strip of tape. */
function Box({
  x,
  y,
  w,
  h,
}: {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}): React.JSX.Element {
  const top = h * 0.28;
  return (
    <g>
      <path
        d={`M${x} ${y + top}c${w * 0.32} -1 ${w * 0.68} -1 ${w} .4l0 ${h - top}c${-w * 0.33} 1 ${-w * 0.67} 1 ${-w} 0Z`}
        fill={PAPER}
        stroke={INK}
        strokeWidth="3.6"
      />
      <path
        d={`M${x} ${y + top}l${w * 0.16} ${-top}c${w * 0.3} -.8 ${w * 0.62} -.8 ${w * 0.96} .2l${-w * 0.12} ${top + 0.4}`}
        fill={PAPER}
        stroke={INK}
        strokeWidth="3.6"
      />
      <path d={hatch(x + 4, y + top + 6, w - 8, h - top - 10, 8)} stroke={SKY} strokeWidth="2.6" />
      <path
        d={`M${x + w * 0.42} ${y + top}l${w * 0.08} ${-top}M${x + w * 0.58} ${y + top}l${w * 0.08} ${-top}M${x + w * 0.42} ${y + top}v${h * 0.26}l${w * 0.08} -${h * 0.06}l${w * 0.08} ${h * 0.06}v-${h * 0.26}`}
        stroke={BLUE}
        strokeWidth="3.2"
      />
    </g>
  );
}

export type SectionKey = 'team' | 'tasks' | 'inventory' | 'reports' | 'pos';

const SECTIONS: Readonly<Record<SectionKey, () => React.JSX.Element>> = {
  // Two employee badges side by side.
  team: () => (
    <>
      <path d={hatch(10, 70, 100, 22, 8)} stroke={SKY} strokeWidth="2.6" />
      <g transform="scale(.66) translate(4 6)">
        <Badge x={58} y={86} tilt={-6} />
        <Badge x={110} y={84} tilt={5} />
      </g>
    </>
  ),
  // A ticked list on paper, and a target with an arrow in its centre.
  tasks: () => (
    <>
      <path d={hatch(8, 70, 104, 22, 8)} stroke={SKY} strokeWidth="2.6" />
      <path
        d="M20 12c17-1.4 34-1.6 51-.6 3 .2 4.8 2 5 5 1 18.6 1 37.6 0 56.2-.2 3-2 4.8-5 5-17 1-34 1-51 0-3-.2-4.8-2-5-5-1-18.6-1-37.6 0-56.2.2-3 2-5 5-5.4Z"
        fill={PAPER}
        stroke={INK}
        strokeWidth="3.4"
      />
      {[26, 42, 58].map((y) => (
        <g key={y}>
          <path
            d={`M24 ${y - 6}c3.4-.3 7-.3 10.4 0 .3 3.4.3 7 0 10.4-3.4.3-7 .3-10.4 0-.3-3.4-.3-7 0-10.4Z`}
            stroke={INK}
            strokeWidth="2.8"
          />
          <path
            d={`M25.4 ${y - 1}c1.4 1.2 2.6 2.6 3.4 4 2.4-4 5.2-7.4 8.4-10.4`}
            stroke={BLUE}
            strokeWidth="3"
          />
          <path d={`M42 ${y}c7.4-.4 15-.4 22.4 0`} stroke={INK} strokeWidth="2.8" />
        </g>
      ))}
      <path
        d="M86 50c-11.6 0-20 8.6-20 19.6S74.6 89 86 89s20-8.6 20-19.6c0-10.6-8-19-18.4-19.4"
        fill={PAPER}
        stroke={INK}
        strokeWidth="3.4"
      />
      <path
        d="M86 59.4c-5.6 0-10 4.4-10 10s4.4 9.8 10 9.8 10-4.4 10-9.8"
        stroke={INK}
        strokeWidth="3"
      />
      <path d="M86 69.4 104.6 51" stroke={BLUE} strokeWidth="3.6" />
      <path d="M99 47.6l7 .2.2 6.8" stroke={BLUE} strokeWidth="3.6" />
      <path d="M96 30l3-9M103 36l8-5" stroke={BLUE} strokeWidth="3.4" />
    </>
  ),
  // A shelf with boxes on two levels.
  inventory: () => (
    <>
      <path d={hatch(6, 74, 108, 18, 8)} stroke={SKY} strokeWidth="2.6" />
      <path d="M14 18c-.6 20-.6 41 .4 62M106 18c.6 20 .6 41-.4 62" stroke={INK} strokeWidth="3.6" />
      <path d="M13.6 50.6c31-1 62-1 93 0M14 78c31-1 62-1 92 0" stroke={INK} strokeWidth="3.6" />
      <g transform="translate(0 0)">
        <Box x={40} y={20} w={40} h={30} />
        <Box x={22} y={53} w={34} h={25} />
        <Box x={64} y={53} w={34} h={25} />
      </g>
    </>
  ),
  // A page with a folded corner and a bar chart.
  reports: () => (
    <>
      <path d={hatch(14, 70, 96, 22, 8)} stroke={SKY} strokeWidth="2.6" />
      <path
        d="M30 10c14-1 28-1.2 42-.4 6.6 6 12.6 12.2 18 18.6.6 16.4.6 33.4-.2 50.2-.2 3-2 4.8-5 5-18 1-36 1-54 0-3-.2-4.8-2-5-5-1-21.6-1-43 0-63.4.2-3 1.6-4.8 4.2-5Z"
        fill={PAPER}
        stroke={INK}
        strokeWidth="3.4"
      />
      <path d="M71.6 10.4c-.6 6.4-.4 12.4.6 18 6 .8 12 .8 17.8 0" stroke={INK} strokeWidth="3.2" />
      <path d="M36 24c8-.4 16-.4 24 0M36 33c10-.4 20-.4 30 0" stroke={INK} strokeWidth="2.8" />
      <path
        d="M38 71c-.4-5.4-.2-10.2.4-14.4h7.4c.6 4.4.6 9.2.2 14.4"
        fill={SKY}
        stroke={BLUE}
        strokeWidth="3.2"
      />
      <path
        d="M52 71c-.4-8.6-.2-16.4.4-23.4h7.4c.6 7.2.6 15 .2 23.4"
        fill={SKY}
        stroke={BLUE}
        strokeWidth="3.2"
      />
      <path
        d="M66 71c-.4-11.6-.2-22.2.4-31.6h7.4c.6 9.6.6 20.2.2 31.6"
        fill={SKY}
        stroke={BLUE}
        strokeWidth="3.2"
      />
      <path d="M33 72.6c15.6-.6 31.4-.6 47 0" stroke={INK} strokeWidth="3" />
    </>
  ),
  // A cash register: receipt, keypad, drawer.
  pos: () => (
    <>
      <path d={hatch(6, 74, 108, 18, 8)} stroke={SKY} strokeWidth="2.6" />
      <path
        d="M48 30.6c-.6-7-.4-14 .6-20.6 7.4-.8 15-.8 22.4 0 1 6.6 1.2 13.6.6 20.6"
        fill={PAPER}
        stroke={INK}
        strokeWidth="3.2"
      />
      <path d="M53 16c4-.3 8-.3 13 0M53 23c3-.3 6-.3 9 0" stroke={INK} strokeWidth="2.6" />
      <path
        d="M30 32.4c20-1.4 40-1.4 60 0 2.6.2 4.2 1.6 4.6 4.2l3.4 20.4c.4 2.6-1 4-3.6 4.2-23 1-46 1-69 0-2.6-.2-4-1.6-3.6-4.2l3.6-20.4c.4-2.6 2-4 4.6-4.2Z"
        fill={PAPER}
        stroke={INK}
        strokeWidth="3.4"
      />
      {[0, 1, 2, 3].map((c) =>
        [0, 1].map((r) => (
          <path
            key={`${c}-${r}`}
            d={`M${36 + c * 12 - r * 1.2} ${40 + r * 9}h8.4l-.4 5.4h-8.4Z`}
            fill={BLUE}
            stroke={BLUE}
            strokeWidth="1.6"
          />
        )),
      )}
      <path
        d="M17 64.6c28.6-1.2 57.4-1.2 86 0 2.6.2 4 1.6 4 4.2v10.6c0 2.6-1.4 4-4 4.2-28.6 1-57.4 1-86 0-2.6-.2-4-1.6-4-4.2V68.8c0-2.6 1.4-4 4-4.2Z"
        fill={PAPER}
        stroke={INK}
        strokeWidth="3.4"
      />
      <path d={hatch(18, 69, 84, 11, 7)} stroke={SKY} strokeWidth="2.4" />
      <path
        d="M60 71.4c-2 0-3.4 1.4-3.4 3.2s1.4 3.2 3.4 3.2 3.4-1.4 3.4-3.2"
        fill={PAPER}
        stroke={INK}
        strokeWidth="2.8"
      />
    </>
  ),
};

export function SectionArt({
  section,
  className,
}: Props & { readonly section: SectionKey }): React.JSX.Element {
  const Draw = SECTIONS[section];
  return (
    <svg
      className={cx('section-art', className)}
      viewBox="0 0 120 96"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <Draw />
    </svg>
  );
}
