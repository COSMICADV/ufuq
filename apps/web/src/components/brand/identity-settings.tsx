'use client';

import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';
import { useCallback, useState } from 'react';

import { loadIdentity, saveIdentity } from '../../lib/brand';
import type { Identity } from '../../lib/brand';
import { Button, Card } from '../design-system';
import { ErrorState, LoadingState } from '../settings/screen-states';
import { useResource } from '../settings/use-resource';

import { changesOf, ContactFields, DetailsFields, draftOf, fieldErrors, LogoSection, PreviewPanel } from './identity-editor';
import type { Draft } from './identity-editor';

/** Settings → Business Identity: the logo, names, colours and contact details. */
export function IdentitySettings({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const load = useCallback(() => loadIdentity(locale, true), [locale]);
  const resource = useResource(load);
  if (resource.state.status === 'loading') return <LoadingState t={t} rows={6} />;
  if (resource.state.status === 'error') return <ErrorState t={t} error={resource.state.error} onRetry={resource.reload} />;
  return <Editor locale={locale} initial={resource.state.value} />;
}

function Editor({ locale, initial }: { readonly locale: Locale; readonly initial: Identity }): React.JSX.Element {
  const t = createTranslator(locale);
  const [identity, setIdentity] = useState(initial);
  const [draft, setDraft] = useState<Draft>(() => draftOf(initial));
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const disabled = !identity.can_edit;
  const changes = changesOf(identity, draft);
  const dirty = Object.keys(changes).length > 0;
  const set = (key: keyof Draft, value: string): void => {
    setDraft((d) => ({ ...d, [key]: value }));
    setNotice(null);
  };
  const save = async (): Promise<void> => {
    setSaving(true);
    setErrors({});
    try {
      const saved = await saveIdentity(locale, changes);
      setIdentity(saved);
      setDraft(draftOf(saved));
      setNotice(t('brand.saved'));
    } catch (error) {
      setErrors(fieldErrors(t, error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="brand-settings">
      {disabled ? <p className="brand-callout">{t('brand.read_only')}</p> : null}
      {notice ? (
        <p className="brand-success" role="status">
          {notice}
        </p>
      ) : null}
      <div className="brand-layout">
        <div className="brand-layout__main">
          <Card title={t('brand.section.logo')}>
            <LogoSection locale={locale} identity={identity} disabled={disabled} onChange={setIdentity} />
          </Card>
          <Card title={t('brand.section.details')}>
            <DetailsFields locale={locale} draft={draft} errors={errors} disabled={disabled} set={set} />
          </Card>
          <Card title={t('brand.section.contact')}>
            <ContactFields locale={locale} draft={draft} errors={errors} disabled={disabled} set={set} />
          </Card>
          {errors.form ? (
            <p className="brand-error" role="alert">
              {errors.form}
            </p>
          ) : null}
          {disabled || !dirty ? null : (
            <div className="brand-actions brand-actions--sticky">
              <Button loading={saving} onClick={() => void save()}>
                {t('brand.save')}
              </Button>
              <Button variant="ghost" onClick={() => setDraft(draftOf(identity))}>
                {t('brand.discard')}
              </Button>
            </div>
          )}
        </div>
        <aside className="brand-layout__side" aria-label={t('brand.preview.title')}>
          <Card title={t('brand.preview.title')}>
            <PreviewPanel locale={locale} identity={identity} draft={draft} />
          </Card>
        </aside>
      </div>
    </div>
  );
}
