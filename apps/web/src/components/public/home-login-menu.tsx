'use client';

import { useEffect, useRef } from 'react';

import { FreehandIcon } from '../freehand-icon';

interface Entry {
  readonly href: string;
  readonly label: string;
  readonly hint: string;
}

/**
 * "Sign in" in the home page's menu: one word that opens the two doors in —
 * the account sign-in and the employee sign-in — each to its existing page.
 *
 * A native <details> so it works before any script has run; the script only
 * adds the niceties: closing on Escape, on a click outside, and after a choice.
 */
export function HomeLoginMenu({
  label,
  account,
  employee,
}: {
  readonly label: string;
  readonly account: Entry;
  readonly employee: Entry;
}): React.JSX.Element {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const menu = ref.current;
    if (menu === null) return undefined;
    const close = (): void => {
      menu.open = false;
    };
    const onPointer = (event: PointerEvent): void => {
      if (menu.open && !menu.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && menu.open) {
        close();
        menu.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <details className="home-login" ref={ref}>
      <summary>
        <span>{label}</span>
        <svg className="home-login__caret" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4 6.2 8 10l4-3.8" />
        </svg>
      </summary>
      <div className="home-login__menu">
        {[
          { entry: account, icon: 'building' as const },
          { entry: employee, icon: 'badge' as const },
        ].map(({ entry, icon }) => (
          <a
            key={entry.href}
            href={entry.href}
            onClick={() => {
              if (ref.current) ref.current.open = false;
            }}
          >
            <span className="home-login__icon">
              <FreehandIcon name={icon} size={24} />
            </span>
            <span>
              <strong>{entry.label}</strong>
              <small>{entry.hint}</small>
            </span>
          </a>
        ))}
      </div>
    </details>
  );
}
