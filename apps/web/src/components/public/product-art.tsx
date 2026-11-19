/**
 * The two product illustrations of 1to1OS, drawn for the project: Business (a
 * briefcase with a rising chart in front of it) and Personal (a person beside a
 * ticked box).
 *
 * Hand-drawn in feel — round caps, lines that overshoot a little where they
 * meet — and built to sit side by side: the same 160×140 canvas, the same ink
 * weight, the same height of drawing. Three colours, each a CSS variable with
 * the brand value as its default, so a dark theme can lift the ink without
 * redrawing:
 *
 *   --art-ink   #0B214A  the outline
 *   --art-blue  #0785FF  the detail that carries the meaning (arrow, tick)
 *   --art-sky   #DDF1FF  light hatching inside the shapes
 *
 * The background is transparent. Decorative: the product name beside it is
 * the accessible label.
 */

const INK = 'var(--art-ink, #0B214A)';
const BLUE = 'var(--art-blue, #0785FF)';
const SKY = 'var(--art-sky, #DDF1FF)';
const PAPER = 'var(--art-paper, #FFFFFF)';
const STROKE = 4.2;

function Frame({
  children,
  className,
}: {
  readonly children: React.ReactNode;
  readonly className?: string | undefined;
}): React.JSX.Element {
  return (
    <svg
      className={['product-art', className].filter(Boolean).join(' ')}
      viewBox="0 0 160 140"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** A briefcase drawn with a round hand; three short bars and a rising blue arrow in front of its lower corner. */
export function BusinessArt({
  className,
}: {
  readonly className?: string | undefined;
}): React.JSX.Element {
  return (
    <Frame className={className}>
      {/* Hatching inside the case, under the ink. */}
      <g stroke={SKY} strokeWidth="3.2">
        <path d="M30 70 52 52" />
        <path d="M30 86 64 58" />
        <path d="M31 101 81 59" />
        <path d="M40 110 96 63" />
        <path d="M57 112 108 69" />
        <path d="M76 112 102 90" />
      </g>
      <g stroke={INK} strokeWidth={STROKE}>
        {/* Handle */}
        <path d="M58.5 44.5c-.4-5.2.2-9.4 1.6-12.3 6.2-1.7 13.6-1.8 20.4-.4 1.5 2.9 2.1 7 1.6 12.6" />
        {/* Case body: a rounded box whose last stroke runs past its first. */}
        <path d="M33 44.8c24.6-1.6 52.4-1.5 76.1.3 5.3.6 8.3 3.6 8.6 9.1.9 14.4.8 31 .1 46.6-.4 6.3-3.7 9.8-9.4 10.3-24.8 1.6-51.4 1.7-76.3-.1-5.3-.5-8.3-3.8-8.7-9.4-1-15.4-.9-31.4 0-46.6.4-5.4 3.6-8.9 9.6-10.4 2-.4 4.4-.5 6.8-.4" />
        {/* The flap's edge across the case */}
        <path d="M24.8 70.6c13.4 4.4 27.2 6.6 40.6 6.9M86.6 77.3c11.5-.6 21.6-2.8 31-6.6" />
        {/* Clasp */}
        <path d="M65.6 70.2c4.6-.6 9.6-.6 14.2 0 .9 3.6.9 7.4.1 10.9-4.7.6-9.6.6-14.2 0-.8-3.6-.9-7.3-.1-10.9Z" />
      </g>
      {/* Three short bars in front of the lower corner, on paper so they hide the case behind. */}
      <g stroke={BLUE} strokeWidth={STROKE} fill={PAPER}>
        <path d="M96.2 128.4c-.4-6.3-.3-11.8.1-16.6 2.8-.4 5.6-.4 8.3 0 .4 5 .5 10.4.2 16.4" />
        <path d="M114.1 128.5c-.5-9.6-.4-18.2.1-25.8 2.8-.4 5.6-.4 8.3 0 .5 7.8.6 16.4.2 25.6" />
        <path d="M132 128.6c-.6-12.6-.5-24.3.1-34.8 2.8-.4 5.6-.4 8.3 0 .6 10.6.7 22.2.2 34.6" />
      </g>
      <path d="M90.4 128.8c18.6.6 37 .5 55.4-.2" stroke={INK} strokeWidth={STROKE} />
      {/* The rising arrow */}
      <g stroke={BLUE} strokeWidth={STROKE}>
        <path d="M88.6 104.6c10.6-6.6 21.6-14.8 32.4-24.2 6-5.4 11.6-11.2 16.4-17.2" />
        <path d="M125.6 61.4c5.4-.8 10.2-1 14.4-.7.6 4.4.4 9-.4 13.6" />
      </g>
    </Frame>
  );
}

/** A person from the head to the shoulders, and beside them a rounded box with a blue tick. */
export function PersonalArt({
  className,
}: {
  readonly className?: string | undefined;
}): React.JSX.Element {
  return (
    <Frame className={className}>
      {/* Hatching inside the head and the shoulders. */}
      <g stroke={SKY} strokeWidth="3.2">
        <path d="M50.4 40.6 64.6 26.6" />
        <path d="M51.4 52.4 74.2 30" />
        <path d="M62.4 53.6 76.6 39.8" />
        <path d="M30 112.6 52.6 90" />
        <path d="M38.8 116.4 68.4 86.8" />
        <path d="M52.6 116.6 82.6 86.6" />
        <path d="M67.6 116.4 90.2 93.8" />
      </g>
      <g stroke={INK} strokeWidth={STROKE}>
        {/* Head */}
        <path d="M63.8 21.6c-9.8.2-17.2 8-17 17.6.2 9.6 8.2 17 17.6 16.8 9.6-.2 17.2-8 17-17.6-.2-9.4-7.4-16.4-16.4-16.8-2.4-.2-4.8.4-7 1.2" />
        {/* Shoulders */}
        <path d="M24.4 117.6c.6-20.6 8.4-34 21.6-40.4 11.4-5.4 25.6-5.2 36.6 1 8 4.6 13.4 12.2 16.2 22.2" />
        <path d="M23.8 117.4c20.6 1.2 42.6 1.4 64.2.4" />
      </g>
      {/* The ticked box beside them, on paper so it sits in front of the shoulder. */}
      <path
        d="M96.4 74.2c11.6-1.2 24.4-1.2 36.4-.2 4.8.4 7.6 3.2 8 8 .9 11.4.9 23.4-.1 35-.4 4.8-3.3 7.6-8.1 8-11.8 1-24.4 1-36.2 0-4.8-.4-7.6-3.3-8-8.1-.9-11.6-.9-23.4.1-34.8.4-4.8 3.2-7.5 7.9-7.9Z"
        stroke={INK}
        strokeWidth={STROKE}
        fill={PAPER}
      />
      <path
        d="M104 100.6c4.2 3.6 7.8 7.4 10.6 11.2 6.4-10.8 14.4-20.4 24.8-29.2"
        stroke={BLUE}
        strokeWidth={STROKE + 0.4}
      />
    </Frame>
  );
}
