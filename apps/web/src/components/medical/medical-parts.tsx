'use client';

import { formatDate, formatTime } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';
import Link from 'next/link';
import type { ReactNode } from 'react';

import type { PersonRef, VisitStatus } from '../../lib/medical';
import { Badge, EmptyState } from '../design-system';

export type Surface = 'admin' | 'app';

export function medicalBase(locale: Locale, surface: Surface): string {
  return `/${locale}/${surface}`;
}

/** The zone visit times are entered in, so what is typed and what is shown agree. */
export function viewZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function when(iso: string, locale: Locale): string {
  const date = new Date(iso);
  const options = { locale, timeZone: viewZone() };
  return `${formatDate(date, options)} · ${formatTime(date, options)}`;
}

export function day(iso: string, locale: Locale): string {
  return formatDate(new Date(`${iso}T12:00:00Z`), { locale, timeZone: 'UTC' });
}

export function personLabel(t: Translator, person: PersonRef): string {
  const role = person.clinical_role ? t(`medical.role.${person.clinical_role}`) : null;
  const detail = [role, person.specialty].filter(Boolean).join(' · ');
  return detail ? `${person.name} — ${detail}` : person.name;
}

const STATUS_TONE: Readonly<Record<VisitStatus, 'info' | 'warning' | 'success' | 'cancelled'>> = {
  scheduled: 'info',
  in_progress: 'warning',
  completed: 'success',
  cancelled: 'cancelled',
};

export function VisitStatusBadge({ t, status }: { readonly t: Translator; readonly status: VisitStatus }): React.JSX.Element {
  return <Badge tone={STATUS_TONE[status]}>{t(`medical.visit_status.${status}`)}</Badge>;
}

export function MedicalPage({
  t,
  crumbs,
  title,
  description,
  action,
  children,
}: {
  readonly t: Translator;
  readonly crumbs: readonly { readonly label: string; readonly href?: string }[];
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="employees medical">
      <main className="employees__content">
        <nav className="page-breadcrumb" aria-label={t('medical.breadcrumb')}>
          <ol>
            {crumbs.map((crumb, index) =>
              crumb.href === undefined ? (
                <li key={index} aria-current="page">
                  {crumb.label}
                </li>
              ) : (
                <li key={index}>
                  <Link href={crumb.href}>{crumb.label}</Link>
                </li>
              ),
            )}
          </ol>
        </nav>
        <header className="page-heading">
          <div>
            <h1>{title}</h1>
            {description === undefined ? null : <p>{description}</p>}
          </div>
          {action ?? null}
        </header>
        {children}
      </main>
    </div>
  );
}

/** A company that is not medical, or a user with no medical grant. */
export function MedicalUnavailable({ t, reason }: { readonly t: Translator; readonly reason: 'disabled' | 'forbidden' }): React.JSX.Element {
  return (
    <EmptyState
      title={t(`medical.unavailable.${reason}_title`)}
      description={t(`medical.unavailable.${reason}_help`)}
      action={null}
    />
  );
}
