'use client';

import { useEffect, useState } from 'react';
import type { Locale, Translator } from '@ufuq/i18n';

import { FreehandIcon } from '../freehand-icon';

/**
 * The greeting at the top of the business dashboard — "Good morning" and
 * today's date in the company's own time zone. Text only: every figure on
 * the page still comes from the widgets below and their APIs.
 *
 * The hour is read after mount, so the server render and the first client
 * render agree and the greeting never flickers between the two.
 */
export function DashboardHero({
  locale,
  t,
  timeZone,
  company,
}: {
  readonly locale: Locale;
  readonly t: Translator;
  readonly timeZone: string;
  readonly company: string;
}): React.JSX.Element {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
  }, []);

  const hour =
    now === null
      ? 9
      : Number(
          new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(
            now,
          ),
        );
  const date =
    now === null
      ? ''
      : new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : locale, {
          weekday: 'long',
          day: 'numeric',
          month: 'long',
          year: 'numeric',
          timeZone,
        }).format(now);

  return (
    <section className="os-hero" aria-label={t('dashboard.title')}>
      <div className="os-hero__text">
        <h2>
          {t(hour < 12 ? 'dashboard.greeting_morning' : 'dashboard.greeting_evening')}
          <span className="os-hero__wave" aria-hidden="true">
            👋
          </span>
        </h2>
        <p>{t('dashboard.greeting_lead', { company })}</p>
      </div>
      <p className="os-hero__date">
        <FreehandIcon name="calendar" size={22} />
        <span>{date}</span>
      </p>
    </section>
  );
}
