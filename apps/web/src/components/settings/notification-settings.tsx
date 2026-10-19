'use client';

import { useCallback, useState } from 'react';
import { createTranslator } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { fetchOne } from '../../lib/api-client';
import { Alert, Button, Card, Toggle } from '../design-system';
import { loadSession } from '../employees/use-session';
import { ErrorState, LoadingState, SuccessNotice } from './screen-states';
import { SettingsHeading } from './settings-shell';
import { useResource } from './use-resource';

/**
 * `/admin/settings/notifications` — DOCUMENT 04 B25 "Notifications —
 * per-event channel toggles", DOCUMENT 19 rule 10.
 *
 * One switch per notification type for the whole company. V1 has one
 * channel (in the app), so there is one switch per row; email and push are
 * named as not available rather than offered. Per-user preferences are
 * future work (DOCUMENT 19) and are not here.
 *
 * Reading needs `settings.view` and saving `settings.update`; the API checks
 * both, and changes are audited `settings.notification_changed`.
 */

interface Setting {
  readonly type: string;
  readonly audience: 'admin' | 'employee';
  readonly priority: 'high' | 'medium' | 'low';
  readonly channels: readonly { readonly channel: 'in_app'; readonly enabled: boolean }[];
}

interface Loaded {
  readonly settings: readonly Setting[];
  readonly canEdit: boolean;
}

function enabledOf(setting: Setting): boolean {
  return setting.channels.find((channel) => channel.channel === 'in_app')?.enabled ?? true;
}

export function NotificationSettings({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const load = useCallback(
    async (signal: AbortSignal): Promise<Loaded> => {
      const [settings, session] = await Promise.all([
        fetchOne<Setting[]>('/settings/notifications', { locale, signal }),
        loadSession(locale, signal),
      ]);
      return { settings, canEdit: session.permissions.has('settings.update') };
    },
    [locale],
  );
  const { state, reload, replace } = useResource(load);
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const heading = (
    <SettingsHeading
      title={t('notifications.settings.title')}
      description={t('notifications.settings.description')}
    />
  );
  if (state.status === 'loading') {
    return (
      <>
        {heading}
        <LoadingState t={t} rows={10} />
      </>
    );
  }
  if (state.status === 'error') {
    return (
      <>
        {heading}
        <ErrorState error={state.error} t={t} onRetry={reload} />
      </>
    );
  }

  const { settings, canEdit } = state.value;
  const current = (setting: Setting): boolean => draft[setting.type] ?? enabledOf(setting);
  const changes = settings.filter((setting) => current(setting) !== enabledOf(setting));

  const save = async (): Promise<void> => {
    if (changes.length === 0) {
      setSaved(t('notifications.settings.unchanged'));
      return;
    }
    setSaving(true);
    setFailed(false);
    try {
      const next = await fetchOne<Setting[]>('/settings/notifications', {
        locale,
        method: 'PATCH',
        body: {
          preferences: changes.map((setting) => ({
            type: setting.type,
            channel: 'in_app',
            enabled: current(setting),
          })),
        },
      });
      replace({ settings: next, canEdit });
      setDraft({});
      setSaved(t('notifications.settings.saved'));
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {heading}
      {canEdit ? null : (
        <Alert tone="info" title={t('notifications.settings.read_only')}>
          {t('notifications.settings.description')}
        </Alert>
      )}
      <SuccessNotice message={saved} t={t} />
      {failed ? (
        <Alert tone="danger" title={t('notifications.ui.action_failed')}>
          {t('state.error_detail')}
        </Alert>
      ) : null}
      {(['admin', 'employee'] as const).map((audience) => (
        <Card key={audience} title={t(`notifications.settings.${audience}_group`)}>
          <ul className="notification-settings">
            {settings
              .filter((setting) => setting.audience === audience)
              .map((setting) => (
                <li key={setting.type}>
                  <Toggle
                    label={t(`notifications.types.${setting.type}`)}
                    checked={current(setting)}
                    disabled={!canEdit || saving}
                    onChange={(event) => {
                      setSaved(null);
                      setDraft((value) => ({ ...value, [setting.type]: event.target.checked }));
                    }}
                  />
                  <span className="notification-settings__meta">
                    {t('notifications.settings.in_app')} ·{' '}
                    {t(`notifications.ui.priority.${setting.priority}`)}
                  </span>
                </li>
              ))}
          </ul>
        </Card>
      ))}
      {canEdit ? (
        <div className="button-row">
          <Button onClick={() => void save()} loading={saving}>
            {t('notifications.settings.save')}
          </Button>
        </div>
      ) : null}
    </>
  );
}
