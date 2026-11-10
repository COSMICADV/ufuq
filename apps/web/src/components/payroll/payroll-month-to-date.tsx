'use client';

import Link from 'next/link';
import { useCallback } from 'react';
import type { Locale, Translator } from '@ufuq/i18n';

import { fetchOne } from '../../lib/api-client';
import { employeePath } from '../../lib/employees';
import type { MonthToDate } from '../../lib/payroll';
import { Alert, Card, DataTable } from '../design-system';
import { Cell } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { Amount } from './payroll-shared';

/**
 * The payroll page's "this month so far": what each employee has earned up
 * to today (`GET /payroll/month-to-date`). Each working day checked in adds
 * the day's salary; an office day also adds the day's transport allowance.
 * Updated as people check in — no payroll run needed.
 */
export function PayrollMonthToDate({
  locale,
  t,
}: {
  readonly locale: Locale;
  readonly t: Translator;
}): React.JSX.Element | null {
  const load = useCallback(
    (signal: AbortSignal) => fetchOne<MonthToDate>('/payroll/month-to-date', { locale, signal }),
    [locale],
  );
  const resource = useResource(load);
  if (resource.state.status !== 'ready') return null;
  const data = resource.state.value;
  if (!data.available || (data.rows.length === 0 && data.missing.length === 0)) return null;
  const currency = data.currency;
  const headers = [
    t('payroll.col_employee'),
    t('salary.office_days'),
    t('salary.home_days'),
    t('salary.earned_salary_col'),
    t('salary.earned_transport_col'),
    t('salary.earned_total_col'),
  ];

  return (
    <Card title={t('salary.month_to_date_title')} className="tasks-table month-to-date">
      <p className="tasks-muted">{t('salary.month_to_date_intro')}</p>
      {data.missing.length > 0 ? (
        <Alert tone="warning" title={t('salary.month_to_date_missing_title')}>
          {data.missing.map((row) => row.employee.name).join('، ')}
        </Alert>
      ) : null}
      {data.rows.length === 0 ? null : (
        <DataTable
          headers={headers}
          rows={[
            ...data.rows.map((row) => [
              <Cell key="employee" label={headers[0] as string}>
                <Link href={employeePath(locale, row.employee.id)}>{row.employee.name}</Link>
              </Cell>,
              <Cell key="office" label={headers[1] as string}>
                <span dir="ltr">{row.earned.office_days}</span>
              </Cell>,
              <Cell key="home" label={headers[2] as string}>
                <span dir="ltr">{row.earned.wfh_days}</span>
              </Cell>,
              <Cell key="salary" label={headers[3] as string}>
                <Amount value={row.earned.salary} currency={currency} locale={locale} />
              </Cell>,
              <Cell key="transport" label={headers[4] as string}>
                <Amount value={row.earned.transport} currency={currency} locale={locale} />
              </Cell>,
              <Cell key="total" label={headers[5] as string}>
                <strong>
                  <Amount value={row.earned.total} currency={currency} locale={locale} />
                </strong>
              </Cell>,
            ]),
            ...(data.totals === null
              ? []
              : [
                  [
                    <Cell key="employee" label={headers[0] as string}>
                      <strong>{t('salary.month_to_date_total')}</strong>
                    </Cell>,
                    <Cell key="office" label={headers[1] as string}>
                      {''}
                    </Cell>,
                    <Cell key="home" label={headers[2] as string}>
                      {''}
                    </Cell>,
                    <Cell key="salary" label={headers[3] as string}>
                      <Amount value={data.totals.salary} currency={currency} locale={locale} />
                    </Cell>,
                    <Cell key="transport" label={headers[4] as string}>
                      <Amount value={data.totals.transport} currency={currency} locale={locale} />
                    </Cell>,
                    <Cell key="total" label={headers[5] as string}>
                      <strong>
                        <Amount value={data.totals.total} currency={currency} locale={locale} />
                      </strong>
                    </Cell>,
                  ],
                ]),
          ]}
        />
      )}
    </Card>
  );
}
