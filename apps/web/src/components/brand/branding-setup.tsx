'use client';

import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';

import { finishOnboarding, loadIdentity, saveIdentity } from '../../lib/brand';
import type { Identity } from '../../lib/brand';
import { Button, Card, EmptyState } from '../design-system';
import { ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { changesOf, ContactFields, DetailsFields, draftOf, fieldErrors, LogoSection, PreviewPanel } from './identity-editor';
import type { Draft } from './identity-editor';

const STEPS = ['logo', 'details', 'contact', 'review'] as const;
type Step = (typeof STEPS)[number];

/**
 * `/admin/setup/branding` — the Restaurant Branding step a restaurant or café
 * admin meets after first sign-in. Every step saves as it goes; Skip keeps
 * what was saved and stops asking (Settings → Business Identity has the same
 * fields for later).
 */
export function BrandingSetup({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const load = useCallback(() => loadIdentity(locale, true), [locale]);
  const resource = useResource(load);
  return (
    <div className="employees brand-setup">
      <main className="employees__content">
      <header className="page-heading">
        <div>
          <h1>{t('brand.setup.title')}</h1>
          <p>{t('brand.setup.help')}</p>
        </div>
      </header>
      {resource.state.status === 'loading' ? (
        <LoadingState t={t} rows={6} />
      ) : resource.state.status === 'error' ? (
        <ErrorState t={t} error={resource.state.error} onRetry={resource.reload} />
      ) : !resource.state.value.can_edit ? (
        <EmptyState title={t('brand.setup.no_access_title')} description={t('brand.setup.no_access_help')} action={null} />
      ) : (
        <Wizard locale={locale} initial={resource.state.value} />
      )}
      </main>
    </div>
  );
}

function Wizard({ locale, initial }: { readonly locale: Locale; readonly initial: Identity }): React.JSX.Element {
  const t = createTranslator(locale);
  const router = useRouter();
  const [step, setStep] = useState<Step>('logo');
  const [identity, setIdentity] = useState(initial);
  const [draft, setDraft] = useState<Draft>(() => {
    const d = draftOf(initial);
    // A first visit starts from the registered company name.
    if (!d.name_ar && !d.name_en) d[locale === 'ar' ? 'name_ar' : 'name_en'] = initial.company_name;
    return d;
  });
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const index = STEPS.indexOf(step);
  const set = (key: keyof Draft, value: string): void => setDraft((d) => ({ ...d, [key]: value }));

  const persist = async (): Promise<boolean> => {
    const changes = changesOf(identity, draft);
    if (Object.keys(changes).length === 0) return true;
    try {
      const saved = await saveIdentity(locale, changes);
      setIdentity(saved);
      setDraft(draftOf(saved));
      return true;
    } catch (error) {
      setErrors(fieldErrors(t, error));
      return false;
    }
  };

  const go = async (next: Step): Promise<void> => {
    setBusy(true);
    setErrors({});
    const ok = await persist();
    setBusy(false);
    if (ok) setStep(next);
  };

  const finish = async (action: 'complete' | 'skip'): Promise<void> => {
    setBusy(true);
    setErrors({});
    if (action === 'complete' && !(await persist())) {
      setBusy(false);
      return;
    }
    try {
      await finishOnboarding(locale, action);
      router.replace(`/${locale}/admin`);
    } catch (error) {
      setErrors(fieldErrors(t, error));
      setBusy(false);
    }
  };

  return (
    <>
      <ol className="brand-steps" aria-label={t('brand.setup.steps')}>
        {STEPS.map((s, i) => (
          <li key={s} aria-current={s === step ? 'step' : undefined} data-done={i < index ? 'true' : undefined}>
            <span className="brand-steps__num">{i + 1}</span>
            <span>{t(`brand.setup.step_${s}`)}</span>
          </li>
        ))}
      </ol>
      <div className="brand-layout">
        <div className="brand-layout__main">
          <Card title={t(`brand.setup.step_${step}`)}>
            {step === 'logo' ? (
              <LogoSection locale={locale} identity={identity} disabled={busy} onChange={setIdentity} />
            ) : step === 'details' ? (
              <DetailsFields locale={locale} draft={draft} errors={errors} disabled={busy} set={set} />
            ) : step === 'contact' ? (
              <ContactFields locale={locale} draft={draft} errors={errors} disabled={busy} set={set} />
            ) : (
              <div className="brand-review">
                <p className="brand-note">{t('brand.setup.review_help')}</p>
                <ul>
                  {(['receipts', 'menu', 'ordering', 'documents'] as const).map((where) => (
                    <li key={where}>{t(`brand.setup.uses_${where}`)}</li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
          {errors.form ? (
            <p className="brand-error" role="alert">
              {errors.form}
            </p>
          ) : null}
          <div className="brand-actions brand-actions--split">
            <Button variant="ghost" onClick={() => void finish('skip')} disabled={busy}>
              {t('brand.setup.skip')}
            </Button>
            <span className="brand-actions">
              {index > 0 ? (
                <Button variant="secondary" onClick={() => setStep(STEPS[index - 1] as Step)} disabled={busy}>
                  {t('brand.setup.back')}
                </Button>
              ) : null}
              {step === 'review' ? (
                <Button loading={busy} onClick={() => void finish('complete')}>
                  {t('brand.setup.finish')}
                </Button>
              ) : (
                <Button loading={busy} onClick={() => void go(STEPS[index + 1] as Step)}>
                  {t('brand.setup.next')}
                </Button>
              )}
            </span>
          </div>
        </div>
        <aside className="brand-layout__side" aria-label={t('brand.preview.title')}>
          <Card title={t('brand.preview.title')}>
            <PreviewPanel locale={locale} identity={identity} draft={draft} />
          </Card>
        </aside>
      </div>
    </>
  );
}
