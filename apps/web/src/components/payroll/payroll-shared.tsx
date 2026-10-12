'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';

import { isDesktopWidth, isNegativeAmount, money, statusTone } from '../../lib/payroll';
import type { PeriodStatus } from '../../lib/payroll';
import { Badge } from '../design-system';

/**
 * The frame the payroll and salary screens sit in — DOCUMENT 03 §7's page
 * skeleton, the same as the request and task screens'.
 */
export function PayrollShell({
  locale,
  surface,
  back,
  children,
}: {
  readonly locale: Locale;
  readonly surface: 'admin' | 'app';
  readonly back?: { readonly href: string; readonly label: string };
  readonly children: ReactNode;
}): React.JSX.Element {
  const t = createTranslator(locale);
  return (
    <div className="tasks-page">
      <header className="page-heading">
        <div>
          <h1>{surface === 'admin' ? t('payroll.title') : t('salary.title')}</h1>
          <p>{surface === 'admin' ? t('payroll.description') : t('salary.description')}</p>
        </div>
        {back === undefined ? null : (
          <Link className="tasks-back" href={back.href}>
            {back.label}
          </Link>
        )}
      </header>
      <main className="tasks-page__content">{children}</main>
    </div>
  );
}

export function PeriodStatusBadge({
  status,
  t,
}: {
  readonly status: PeriodStatus;
  readonly t: Translator;
}): React.JSX.Element {
  return <Badge tone={statusTone(status)}>{t(`payroll.status.${status}`)}</Badge>;
}

/** An amount, left-to-right inside any text, with its piastres. */
export function Amount({
  value,
  currency,
  locale,
}: {
  readonly value: string;
  readonly currency: string;
  readonly locale: Locale;
}): React.JSX.Element {
  return (
    <span
      dir="ltr"
      className={isNegativeAmount(value) ? 'payroll-amount is-negative' : 'payroll-amount'}
    >
      {money(value, currency, locale)}
    </span>
  );
}

/**
 * DOCUMENT 15 rule 10: the current month is an estimate until finalized, and
 * the label is prominent — on a phone most of all.
 */
export function ProvisionalBadge({ t }: { readonly t: Translator }): React.JSX.Element {
  return <Badge tone="warning">{t('salary.provisional')}</Badge>;
}

/**
 * Whether the viewport is a desktop one (DOCUMENT 22, ≥ 1024px). Null until
 * measured, so nothing desktop-only is offered before the answer is known.
 * Used to leave payroll finalization out of the mobile presentation entirely.
 */
export function useIsDesktop(): boolean | null {
  const [desktop, setDesktop] = useState<boolean | null>(null);
  useEffect(() => {
    const update = (): void => {
      setDesktop(isDesktopWidth(window.innerWidth));
    };
    update();
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
    };
  }, []);
  return desktop;
}

/** A labelled figure in a summary grid. */
export function Figure({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="payroll-figure">
      <span className="payroll-figure__label">{label}</span>
      <strong className="payroll-figure__value">{children}</strong>
    </div>
  );
}
