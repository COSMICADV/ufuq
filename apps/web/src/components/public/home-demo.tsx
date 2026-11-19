'use client';

import { useEffect, useRef, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { FreehandIcon } from '../freehand-icon';
import type { FreehandIconName } from '../freehand-icon';

/**
 * A short demo on the home page: one finished task in QR Studio, from the
 * first choice to the result — a restaurant menu behind a QR code, opened on a
 * phone. It replays the studio's own steps (code type → content → design →
 * download) with sample data, in 1to1OS's design; nothing here talks to the API.
 *
 * Timing lives in CSS: each step's progress bar is an animation, and when it
 * ends the next step starts. Pausing pauses that animation, so the demo stops
 * exactly where it is. It plays only while on screen, and never on its own
 * for someone who asked for reduced motion.
 */

const STEPS = 5;

/** The studio's code types shown in the first step, the menu being the one chosen. */
const TYPES: readonly (readonly [string, FreehandIconName])[] = [
  ['tUrl', 'globe'],
  ['tMenu', 'utensils'],
  ['tWifi', 'wifi'],
  ['tCard', 'badge'],
  ['tBusiness', 'building'],
  ['tSocial', 'message'],
];

const COLOURS = ['#0B214A', '#0785FF', '#16A36B', '#F97316', '#7C5CFF'] as const;

/**
 * A decorative 21×21 code: the three finder squares a reader expects and a
 * fixed scatter of modules between them. It does not encode anything.
 */
const QR_PATH = ((): string => {
  const size = 21;
  const finder = (x: number, y: number): boolean => {
    const at = (fx: number, fy: number): boolean | undefined => {
      const dx = x - fx;
      const dy = y - fy;
      if (dx < 0 || dy < 0 || dx > 6 || dy > 6) return undefined;
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      return ring !== 2;
    };
    return at(0, 0) ?? at(14, 0) ?? at(0, 14) ?? false;
  };
  const reserved = (x: number, y: number): boolean =>
    (x < 8 && y < 8) || (x > 12 && y < 8) || (x < 8 && y > 12);
  let d = '';
  let seed = 7;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const on = reserved(x, y) ? finder(x, y) : seed % 100 < 47;
      if (on) d += `M${x} ${y}h1v1h-1z`;
    }
  }
  return d;
})();

function DemoQr({
  colour,
  framed,
  text,
}: {
  readonly colour: string;
  readonly framed: boolean;
  readonly text: string;
}): React.JSX.Element {
  return (
    <span
      className={`demo-qr${framed ? ' demo-qr--framed' : ''}`}
      style={{ '--qr': colour } as React.CSSProperties}
    >
      <svg viewBox="-2 -2 25 25" aria-hidden="true">
        <rect x="-2" y="-2" width="25" height="25" rx="2.5" fill="#fff" />
        <path d={QR_PATH} fill="currentColor" />
      </svg>
      {framed ? <span className="demo-qr__frame">{text}</span> : null}
    </span>
  );
}

export function HomeDemo({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const d = (key: string, values?: Record<string, string>): string => t(`home.demo.${key}`, values);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [visible, setVisible] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // Play by default, unless the visitor prefers reduced motion.
  useEffect(() => {
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) setPlaying(true);
  }, []);

  // Run only while the demo is on screen.
  useEffect(() => {
    const node = root.current;
    if (node === null || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? false),
      {
        threshold: 0.35,
      },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const running = playing && visible;
  const next = (): void => setStep((s) => (s + 1) % STEPS);
  const menuItems: readonly (readonly [string, string])[] = [
    ['i1', 'p1'],
    ['i2', 'p2'],
  ];
  const drinks: readonly (readonly [string, string])[] = [
    ['i3', 'p3'],
    ['i4', 'p4'],
  ];
  const colour = step >= 2 ? COLOURS[1] : COLOURS[0];

  const menuPage = (
    <div className="demo-menu" style={{ '--menu': colour } as React.CSSProperties}>
      <div className="demo-menu__head">
        <span className="demo-menu__logo" aria-hidden="true">
          <FreehandIcon name="utensils" size={20} />
        </span>
        <strong>{d('menuName')}</strong>
        <small>{d('menuTag')}</small>
      </div>
      {(
        [
          ['sec1', menuItems],
          ['sec2', drinks],
        ] as const
      ).map(([section, items], s) => (
        <div
          className="demo-menu__section"
          key={section}
          style={{ '--i': s * 2 } as React.CSSProperties}
        >
          <b>{d(section)}</b>
          {items.map(([item, price], i) => (
            <p key={item} style={{ '--i': s * 2 + i + 1 } as React.CSSProperties}>
              <span>{d(item)}</span>
              <span dir="ltr">
                {d(price)} {d('currency')}
              </span>
            </p>
          ))}
        </div>
      ))}
    </div>
  );

  let pane: React.JSX.Element;
  if (step === 0) {
    pane = (
      <div className="demo-types">
        {TYPES.map(([key, icon]) => (
          <span key={key} className={`demo-type${key === 'tMenu' ? ' is-chosen' : ''}`}>
            <FreehandIcon name={icon} size={26} />
            <span>{d(key)}</span>
          </span>
        ))}
        <span className="demo-cursor" aria-hidden="true" />
      </div>
    );
  } else if (step === 1) {
    pane = (
      <div className="demo-form">
        <span className="demo-field">
          <small>{d('fName')}</small>
          <span className="demo-input">{d('menuName')}</span>
        </span>
        <span className="demo-field">
          <small>{d('fItems')}</small>
          <span className="demo-input demo-input--area">
            {[
              `# ${d('sec1')}`,
              `${d('i1')} | ${d('p1')}`,
              `${d('i2')} | ${d('p2')}`,
              `# ${d('sec2')}`,
              `${d('i3')} | ${d('p3')}`,
              `${d('i4')} | ${d('p4')}`,
            ].map((line, i) => (
              <span key={line} className="demo-line" style={{ '--i': i } as React.CSSProperties}>
                {line}
              </span>
            ))}
          </span>
        </span>
      </div>
    );
  } else if (step === 2) {
    pane = (
      <div className="demo-design">
        <div className="demo-design__opts">
          <small>{d('colour')}</small>
          <span className="demo-swatches">
            {COLOURS.map((c) => (
              <span
                key={c}
                className={c === COLOURS[1] ? 'is-chosen' : undefined}
                style={{ background: c }}
              />
            ))}
          </span>
          <small>{d('frame')}</small>
          <span className="demo-frames">
            <span>—</span>
            <span className="is-chosen">{d('frameText')}</span>
          </span>
        </div>
        <DemoQr colour={COLOURS[1]} framed text={d('frameText')} />
      </div>
    );
  } else if (step === 3) {
    pane = (
      <div className="demo-ready">
        <DemoQr colour={COLOURS[1]} framed text={d('frameText')} />
        <div className="demo-ready__side">
          <strong>
            <FreehandIcon name="check" size={22} /> {d('ready')}
          </strong>
          <span className="demo-link" dir="ltr">
            1to1os.com/q/nile-menu
          </span>
          <span className="demo-download">{d('download')}</span>
          <span className="demo-scans">
            <b dir="ltr">12</b> {d('scans')}
          </span>
        </div>
      </div>
    );
  } else {
    pane = (
      <div className="demo-scan">
        <DemoQr colour={COLOURS[1]} framed text={d('frameText')} />
        <span className="demo-scan__hint">{d('scanHint')}</span>
      </div>
    );
  }

  const wizard = Math.min(step, 2);

  return (
    <div className="demo" ref={root}>
      <div className="demo-stage" data-step={step} aria-hidden="true">
        <div className="demo-window">
          <div className="demo-window__bar">
            <span className="demo-window__dots">
              <i />
              <i />
              <i />
            </span>
            <span>{d('studio')}</span>
          </div>
          <ol className="demo-wiz">
            {(['wizType', 'wizContent', 'wizDesign'] as const).map((key, i) => (
              <li
                key={key}
                className={i === wizard ? 'is-on' : i < wizard || step > 2 ? 'is-done' : undefined}
              >
                <span>{i < wizard || step > 2 ? '✓' : i + 1}</span>
                {d(key)}
              </li>
            ))}
          </ol>
          <div className="demo-body">
            <div className="demo-pane" key={step}>
              {pane}
            </div>
            <div className="demo-phone">
              <div className="demo-phone__screen">
                {step === 0 ? (
                  <div className="demo-phone__empty">
                    <i />
                    <i />
                    <i />
                  </div>
                ) : step === 4 ? (
                  <div className="demo-phone__scan" key="scan">
                    <span className="demo-phone__camera">
                      <DemoQr colour={COLOURS[1]} framed={false} text="" />
                    </span>
                    <span className="demo-phone__opened">{menuPage}</span>
                  </div>
                ) : (
                  menuPage
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="demo-controls">
        <button
          type="button"
          className="demo-play"
          onClick={() => setPlaying((p) => !p)}
          aria-pressed={playing}
        >
          <span className={`demo-play__icon${playing ? ' is-playing' : ''}`} aria-hidden="true" />
          {playing ? d('pause') : d('play')}
        </button>
        <ol className="demo-steps" aria-label={d('stepsLabel')}>
          {Array.from({ length: STEPS }, (_, i) => (
            <li key={i} aria-current={i === step ? 'step' : undefined}>
              <button
                type="button"
                onClick={() => setStep(i)}
                aria-label={d('goTo', { n: String(i + 1) })}
              >
                <span className="demo-steps__n" dir="ltr">
                  {i + 1}
                </span>
                <span className="demo-steps__text">
                  <strong>{d(`s${i + 1}Title`)}</strong>
                  <small>{d(`s${i + 1}Body`)}</small>
                </span>
              </button>
              {i === step ? (
                <span className="demo-steps__bar" aria-hidden="true">
                  <span
                    key={`${step}`}
                    style={{ animationPlayState: running ? 'running' : 'paused' }}
                    onAnimationEnd={next}
                  />
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
