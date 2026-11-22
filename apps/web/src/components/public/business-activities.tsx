'use client';

import { useEffect, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { ACTIVITIES, activityById, ONBOARDING_KEY } from '../../lib/business-activities';
import type { ActivityId } from '../../lib/business-activities';

/**
 * "Choose your business activity" — a real selector, not an illustration.
 * One card at a time; the choice is kept as the onboarding state and carried
 * into the existing sign-up (the company's request for its workspace), which
 * stores it on the company. Selecting creates nothing and charges nothing.
 */
export function BusinessActivities({
  locale,
  registerPath,
}: {
  readonly locale: Locale;
  readonly registerPath: string;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const [selected, setSelected] = useState<ActivityId | null>(null);
  const [subtype, setSubtype] = useState<string | null>(null);
  const [step, setStep] = useState<'activity' | 'subtype'>('activity');

  // Coming back from sign-up ("change"), the earlier choice is still there.
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(ONBOARDING_KEY) ?? 'null') as {
        activity?: string;
        subtype?: string | null;
      } | null;
      const found = activityById(saved?.activity);
      if (found) {
        setSelected(found.id);
        setSubtype(saved?.subtype && found.subtypes?.includes(saved.subtype) ? saved.subtype : null);
      }
    } catch {
      // Storage unavailable: start fresh.
    }
  }, []);

  const config = activityById(selected);

  const remember = (activity: ActivityId | null, sub: string | null): void => {
    try {
      if (activity) sessionStorage.setItem(ONBOARDING_KEY, JSON.stringify({ activity, subtype: sub }));
      else sessionStorage.removeItem(ONBOARDING_KEY);
    } catch {
      // Not essential: the choice also travels in the link.
    }
  };

  const go = (activity: ActivityId, sub: string | null): void => {
    remember(activity, sub);
    const query = new URLSearchParams({ activity, ...(sub ? { subtype: sub } : {}) });
    window.location.assign(`${registerPath}?${query.toString()}`);
  };

  const pick = (id: ActivityId): void => {
    setSelected(id);
    setSubtype(null);
    setStep('activity');
    remember(id, null);
  };

  return (
    <section id="activities" className="biz-sections biz-activities" aria-labelledby="biz-activities-title">
      <h2 id="biz-activities-title">{t('activity.title')}</h2>
      <p className="biz-activities__lead">{t('activity.subtitle')}</p>

      <div className="biz-activity-grid" role="radiogroup" aria-labelledby="biz-activities-title">
        {ACTIVITIES.map((a) => {
          const on = selected === a.id;
          return (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={on}
              className={`biz-activity${on ? ' is-selected' : ''}`}
              onClick={() => {
                pick(a.id);
              }}
            >
              {on ? (
                <span className="biz-activity__check" aria-hidden="true">
                  <svg viewBox="0 0 16 16">
                    <path d="M3.5 8.4l2.9 2.9 6.1-6.6" />
                  </svg>
                </span>
              ) : null}
              <img src={a.icon} alt="" width={108} height={78} decoding="async" />
              <strong>{t(`activity.${a.id}.name`)}</strong>
              <span>{t(`activity.${a.id}.tagline`)}</span>
            </button>
          );
        })}
      </div>

      <div className="biz-activity-next" aria-live="polite">
        {config === null ? (
          <p className="biz-activity-next__hint">{t('activity.pick_hint')}</p>
        ) : step === 'subtype' && config.subtypes ? (
          <div className="biz-activity-panel">
            <h3>{t(`activity.${config.id}.subtype_question`)}</h3>
            <div className="biz-subtypes" role="radiogroup" aria-label={t(`activity.${config.id}.subtype_question`)}>
              {config.subtypes.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={subtype === s}
                  className={`biz-subtype${subtype === s ? ' is-selected' : ''}`}
                  onClick={() => {
                    setSubtype(s);
                    remember(config.id, s);
                  }}
                >
                  <strong>{t(`activity.subtype.${s}.name`)}</strong>
                  <span>{t(`activity.subtype.${s}.description`)}</span>
                </button>
              ))}
            </div>
            <div className="biz-activity-panel__actions">
              <button
                type="button"
                className="biz-activity-back"
                onClick={() => {
                  setStep('activity');
                }}
              >
                {t('activity.back')}
              </button>
              <button
                type="button"
                className="biz-cta"
                disabled={subtype === null}
                onClick={() => {
                  if (subtype) go(config.id, subtype);
                }}
              >
                {t('activity.continue')}
              </button>
            </div>
          </div>
        ) : (
          <div className="biz-activity-panel">
            <h3>{t(`activity.${config.id}.name`)}</h3>
            <p>{t(`activity.${config.id}.description`)}</p>
            <p className="biz-activity-panel__modules-label">{t('activity.modules_label')}</p>
            <ul className="biz-activity-panel__modules">
              {config.modules.map((m) => (
                <li key={m}>{t(`business.${m}`)}</li>
              ))}
            </ul>
            <div className="biz-activity-panel__actions">
              <button
                type="button"
                className="biz-cta"
                onClick={() => {
                  if (config.subtypes) setStep('subtype');
                  else go(config.id, null);
                }}
              >
                {t('activity.continue')}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
