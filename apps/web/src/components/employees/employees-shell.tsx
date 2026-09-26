import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * The frame every employees screen sits in — DOCUMENT 03 §7's page skeleton:
 * breadcrumb, then title with the primary action, then the screen.
 *
 * No hooks and no browser APIs, so the same components render inside the
 * client screens (which know the employee's name only after fetching it).
 *
 * Like the Phase 4 settings frame, this is not the eleven-item product
 * sidebar from DOCUMENT 03 §2: most of those modules belong to later phases,
 * and linking to them now would be a "coming soon" panel by another name
 * (DOCUMENT 27 RULE 26).
 */

export function EmployeesShell({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return (
    <div className="employees">
      <main className="employees__content">{children}</main>
    </div>
  );
}

export interface Crumb {
  readonly label: string;
  /** Omitted for the current page. */
  readonly href?: string;
}

/** DOCUMENT 03 §6: breadcrumbs on every page below the top level. */
export function EmployeesBreadcrumb({
  label,
  items,
}: {
  readonly label: string;
  readonly items: readonly Crumb[];
}): React.JSX.Element {
  return (
    <nav className="page-breadcrumb" aria-label={label}>
      <ol>
        {items.map((item, index) =>
          item.href === undefined ? (
            <li key={index} aria-current="page">
              {item.label}
            </li>
          ) : (
            <li key={index}>
              <Link href={item.href}>{item.label}</Link>
            </li>
          ),
        )}
      </ol>
    </nav>
  );
}

/** Title, one-line explanation, and the screen's primary action on the opposite side. */
export function EmployeesHeading({
  title,
  description,
  action,
}: {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
}): React.JSX.Element {
  return (
    <header className="page-heading">
      <div>
        <h1>{title}</h1>
        {description === undefined ? null : <p>{description}</p>}
      </div>
      {action ?? null}
    </header>
  );
}
