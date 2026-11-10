'use client';

/**
 * The platform owner's sign-up review. The owner key arrives in the URL
 * fragment from the notification email (`#key=…&request=…`) or is pasted in;
 * it is kept in `sessionStorage` for this tab only and sent as the
 * `x-owner-key` header. The fragment is cleared from the address bar as soon
 * as it is read, so the key does not linger in history or screenshots.
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { createTranslator, formatDateTime } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';
import { apiUrl } from '../../lib/api-client';
import { BrandMark, Wordmark } from '../brand-mark';
import { ThemePicker } from '../theme-picker';
import { Alert, Badge, Button, Field, Input, Skeleton } from '../design-system';

const STORAGE_KEY = 'oneToOne.ownerKey';

interface SignupRequest {
  readonly company_id: string;
  readonly company_name: string;
  readonly employee_count_range: string | null;
  readonly status: 'pending_approval' | 'active' | 'rejected';
  readonly created_at: string;
  readonly reviewed_at: string | null;
  readonly admin_name: string | null;
  readonly admin_email: string;
  readonly admin_phone: string | null;
}

type LoadState = 'locked' | 'loading' | 'ready' | 'error';

function readStoredKey(): string {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}
function storeKey(key: string): void {
  try {
    if (key) window.sessionStorage.setItem(STORAGE_KEY, key);
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable (private mode); the key then lasts until reload.
  }
}

export function OwnerRequests({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const t = createTranslator(locale);
  const [key, setKey] = useState('');
  const [draft, setDraft] = useState('');
  const [state, setState] = useState<LoadState>('locked');
  const [lockReason, setLockReason] = useState<'none' | 'wrong' | 'missing'>('none');
  const [rows, setRows] = useState<readonly SignupRequest[]>([]);
  const [focus, setFocus] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const request = useCallback(
    async (path: string, ownerKey: string, method: 'GET' | 'POST' = 'GET'): Promise<Response> =>
      fetch(apiUrl(path), {
        method,
        headers: { 'x-owner-key': ownerKey, 'accept-language': locale },
        cache: 'no-store',
      }),
    [locale],
  );

  const load = useCallback(
    async (ownerKey: string): Promise<void> => {
      if (!ownerKey) {
        setState('locked');
        return;
      }
      setState('loading');
      try {
        const res = await request('/owner/signup-requests', ownerKey);
        if (res.status === 401 || res.status === 429) {
          storeKey('');
          setKey('');
          setLockReason('wrong');
          setState('locked');
          return;
        }
        if (res.status === 404) {
          setLockReason('missing');
          setState('locked');
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { data: SignupRequest[] };
        setRows(body.data);
        setState('ready');
      } catch {
        setState('error');
      }
    },
    [request],
  );

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const fromHash = hash.get('key') ?? '';
    const target = hash.get('request');
    if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    const initial = fromHash || readStoredKey();
    if (fromHash) storeKey(fromHash);
    if (target) setFocus(target);
    setKey(initial);
    void load(initial);
  }, [load]);

  useEffect(() => {
    if (state !== 'ready' || !focus) return;
    document.getElementById(`request-${focus}`)?.scrollIntoView({ block: 'center' });
  }, [state, focus]);

  const decide = async (row: SignupRequest, decision: 'approve' | 'reject'): Promise<void> => {
    setBusy(row.company_id);
    setNotice(null);
    try {
      const res = await request(
        `/owner/signup-requests/${row.company_id}/${decision}`,
        key,
        'POST',
      );
      if (!res.ok) throw new Error(String(res.status));
      setNotice({
        tone: 'success',
        text: t(decision === 'approve' ? 'owner.approved_notice' : 'owner.rejected_notice', {
          company: row.company_name,
        }),
      });
      setConfirming(null);
      await load(key);
    } catch {
      setNotice({ tone: 'danger', text: t('owner.action_error') });
    } finally {
      setBusy(null);
    }
  };

  const date = (iso: string): string =>
    formatDateTime(new Date(iso), { locale, timeZone: 'Africa/Cairo' });
  const pending = rows.filter((r) => r.status === 'pending_approval');
  const reviewed = rows.filter((r) => r.status !== 'pending_approval');

  const card = (row: SignupRequest): React.JSX.Element => (
    <article
      key={row.company_id}
      id={`request-${row.company_id}`}
      className={`owner-request${focus === row.company_id ? ' owner-request--focus' : ''}`}
    >
      <header className="owner-request__head">
        <div>
          <h3>{row.company_name}</h3>
          {focus === row.company_id ? (
            <span className="owner-request__from">{t('owner.highlight')}</span>
          ) : null}
        </div>
        <Badge
          tone={
            row.status === 'pending_approval'
              ? 'warning'
              : row.status === 'active'
                ? 'success'
                : 'danger'
          }
        >
          {t(
            row.status === 'pending_approval'
              ? 'owner.status_pending'
              : row.status === 'active'
                ? 'owner.status_active'
                : 'owner.status_rejected',
          )}
        </Badge>
      </header>
      <dl className="owner-request__facts">
        <div>
          <dt>{t('owner.admin')}</dt>
          <dd>{row.admin_name ?? '—'}</dd>
        </div>
        <div>
          <dt>{t('owner.email')}</dt>
          <dd dir="ltr">
            <a href={`mailto:${row.admin_email}`}>{row.admin_email}</a>
          </dd>
        </div>
        <div>
          <dt>{t('owner.phone')}</dt>
          <dd dir="ltr">{row.admin_phone ?? '—'}</dd>
        </div>
        <div>
          <dt>{t('owner.employees')}</dt>
          <dd dir="ltr">{row.employee_count_range ?? '—'}</dd>
        </div>
        <div>
          <dt>{t('owner.requested_at')}</dt>
          <dd>{date(row.created_at)}</dd>
        </div>
        {row.reviewed_at ? (
          <div>
            <dt>{t('owner.reviewed_at')}</dt>
            <dd>{date(row.reviewed_at)}</dd>
          </div>
        ) : null}
      </dl>
      {row.status === 'pending_approval' ? (
        <div className="owner-request__actions">
          {confirming === row.company_id ? (
            <>
              <p className="owner-request__confirm">
                {t('owner.confirm_reject', { company: row.company_name })}
              </p>
              <Button
                variant="destructive"
                loading={busy === row.company_id}
                onClick={() => void decide(row, 'reject')}
              >
                {t('owner.reject')}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(null)}>
                {t('action.cancel')}
              </Button>
            </>
          ) : (
            <>
              <Button loading={busy === row.company_id} onClick={() => void decide(row, 'approve')}>
                {t('owner.approve')}
              </Button>
              <Button
                variant="destructive-ghost"
                disabled={busy === row.company_id}
                onClick={() => setConfirming(row.company_id)}
              >
                {t('owner.reject')}
              </Button>
            </>
          )}
        </div>
      ) : null}
    </article>
  );

  return (
    <div className="owner-page">
      <header className="owner-bar">
        <Link className="owner-brand" href={`/${locale}`}>
          <BrandMark />
          <Wordmark />
        </Link>
        <div className="owner-bar__actions">
          <ThemePicker locale={locale} />
          <Link
            href={`/${locale === 'ar' ? 'en' : 'ar'}/owner`}
            hrefLang={locale === 'ar' ? 'en' : 'ar'}
          >
            {locale === 'ar' ? 'English' : 'العربية'}
          </Link>
          {state === 'ready' || state === 'error' ? (
            <>
              <Button variant="secondary" size="sm" onClick={() => void load(key)}>
                {t('owner.refresh')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  storeKey('');
                  setKey('');
                  setRows([]);
                  setLockReason('none');
                  setState('locked');
                }}
              >
                {t('owner.lock')}
              </Button>
            </>
          ) : null}
        </div>
      </header>
      <main className="owner-main">
        <div className="owner-intro">
          <p className="owner-eyebrow">
            <Wordmark /> · {t('owner.key_label')}
          </p>
          <h1>{t('owner.title')}</h1>
          <p>{t('owner.subtitle')}</p>
        </div>

        {state === 'locked' ? (
          <form
            className="owner-unlock"
            onSubmit={(e) => {
              e.preventDefault();
              const next = draft.trim();
              storeKey(next);
              setKey(next);
              setLockReason('none');
              void load(next);
            }}
          >
            {lockReason === 'wrong' ? (
              <Alert tone="danger" title={t('owner.wrong_key')}>
                {t('owner.key_help')}
              </Alert>
            ) : null}
            {lockReason === 'missing' ? (
              <Alert tone="warning" title={t('owner.not_configured')}>
                {t('owner.key_help')}
              </Alert>
            ) : null}
            <Field label={t('owner.key_label')} helper={t('owner.key_help')} required>
              <Input
                type="password"
                dir="ltr"
                autoComplete="current-password"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                required
                minLength={32}
              />
            </Field>
            <Button type="submit" size="lg">
              {t('owner.unlock')}
            </Button>
          </form>
        ) : null}

        {state === 'loading' ? <Skeleton lines={6} /> : null}

        {state === 'error' ? (
          <Alert tone="danger" title={t('owner.load_error')}>
            <Button variant="secondary" size="sm" onClick={() => void load(key)}>
              {t('action.retry')}
            </Button>
          </Alert>
        ) : null}

        {state === 'ready' ? (
          <>
            {notice ? (
              <Alert tone={notice.tone} title={notice.text}>
                {''}
              </Alert>
            ) : null}
            <section className="owner-section" aria-labelledby="owner-pending">
              <h2 id="owner-pending">
                {t('owner.pending')}
                <span className="owner-count">
                  {t('owner.count_pending', { count: String(pending.length) })}
                </span>
              </h2>
              {pending.length ? (
                <div className="owner-list">{pending.map(card)}</div>
              ) : (
                <p className="owner-empty">{t('owner.empty_pending')}</p>
              )}
            </section>
            <section className="owner-section" aria-labelledby="owner-reviewed">
              <h2 id="owner-reviewed">{t('owner.reviewed')}</h2>
              {reviewed.length ? (
                <div className="owner-list">{reviewed.map(card)}</div>
              ) : (
                <p className="owner-empty">{t('owner.empty_reviewed')}</p>
              )}
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}
