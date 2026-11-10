'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { applyTheme, DEFAULT_THEME, readStoredTheme, themeLabelKey, THEMES } from '../lib/themes';
import type { Theme } from '../lib/themes';

/** The menu's width in theme.css (`min-inline-size`). */
const MENU_WIDTH = 210;

/**
 * The colour-theme picker — on the home page, the public pages and every
 * workspace screen. A button that opens a short menu of the four themes;
 * choosing one applies it at once and remembers it in this browser
 * (`lib/themes.ts`).
 */
export function ThemePicker({
  locale,
  className,
}: {
  readonly locale: Locale;
  readonly className?: string;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const [theme, setTheme] = useState<Theme>(DEFAULT_THEME);
  const [open, setOpen] = useState(false);
  // Which physical edge the menu hangs from: whichever leaves it on screen, in either direction.
  const [edge, setEdge] = useState<'left' | 'right'>('right');
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  // The server cannot know the stored choice; read it once mounted.
  useEffect(() => {
    setTheme(readStoredTheme());
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const first = root.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
    first?.focus();
    const onPointer = (event: PointerEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
        toggle.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (next: Theme): void => {
    applyTheme(next);
    setTheme(next);
    setOpen(false);
    toggle.current?.focus();
  };

  const onMenuKey = (event: React.KeyboardEvent<HTMLUListElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [
      ...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []),
    ];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
  };

  return (
    <div ref={root} className={['theme-picker', className].filter(Boolean).join(' ')}>
      <button
        ref={toggle}
        type="button"
        className="theme-picker__toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`${t('theme.label')}: ${t(themeLabelKey(theme))}`}
        onClick={() => {
          const rect = toggle.current?.getBoundingClientRect();
          if (rect !== undefined) {
            setEdge(rect.right - MENU_WIDTH >= 8 ? 'right' : 'left');
          }
          setOpen((value) => !value);
        }}
      >
        <span className={`theme-swatch theme-swatch--${theme}`} aria-hidden="true" />
        <span className="theme-picker__label">{t('theme.label')}</span>
      </button>
      {open ? (
        <ul
          id={menuId}
          className="theme-picker__menu"
          role="menu"
          aria-label={t('theme.label')}
          style={edge === 'right' ? { right: 0 } : { left: 0 }}
          onKeyDown={onMenuKey}
        >
          {THEMES.map((candidate) => (
            <li key={candidate} role="none">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={candidate === theme}
                className="theme-picker__option"
                onClick={() => {
                  choose(candidate);
                }}
              >
                <span className={`theme-swatch theme-swatch--${candidate}`} aria-hidden="true" />
                <span>{t(themeLabelKey(candidate))}</span>
                {candidate === theme ? (
                  <svg
                    className="theme-picker__check"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
