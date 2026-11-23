'use client';

import { createTranslator } from '@ufuq/i18n';
import type { Locale, Translator } from '@ufuq/i18n';
import { useEffect, useRef, useState } from 'react';

import { ApiError } from '../../lib/api-client';
import {
  ACCEPTED_LOGO,
  contrastRatio,
  DEFAULT_PRIMARY,
  DEFAULT_SECONDARY,
  isHexColor,
  makeThermal,
  MAX_LOGO_BYTES,
  removeLogo,
  svgImage,
  svgLooksUnsafe,
  uploadLogo,
} from '../../lib/brand';
import type { Identity, IdentityText, ThermalCopy } from '../../lib/brand';
import { PhotoEditor } from '../capture/photo-editor';
import { Button, Field, Input } from '../design-system';

import { ReceiptPreview } from './receipt-preview';
import { useLogoUrl } from './use-identity';

export type Draft = { -readonly [K in keyof IdentityText]: string };

export function draftOf(identity: Identity): Draft {
  return {
    name_ar: identity.name_ar ?? '',
    name_en: identity.name_en ?? '',
    primary_color: identity.primary_color ?? '',
    secondary_color: identity.secondary_color ?? '',
    phone: identity.phone ?? '',
    whatsapp: identity.whatsapp ?? '',
    email: identity.email ?? '',
    website: identity.website ?? '',
    address_ar: identity.address_ar ?? '',
    address_en: identity.address_en ?? '',
    instagram: identity.instagram ?? '',
    facebook: identity.facebook ?? '',
    tiktok: identity.tiktok ?? '',
  };
}

/** Only what changed, empty meaning "clear". A bare domain gets https://. */
export function changesOf(identity: Identity, draft: Draft): Partial<IdentityText> {
  const out: Record<string, string | null> = {};
  const urlFields = new Set(['website', 'instagram', 'facebook', 'tiktok']);
  for (const key of Object.keys(draft) as (keyof Draft)[]) {
    let value = draft[key].trim();
    if (value && urlFields.has(key) && !/^https?:\/\//i.test(value)) value = `https://${value}`;
    if (value && (key === 'primary_color' || key === 'secondary_color')) value = value.toUpperCase();
    const current = identity[key] ?? '';
    if (value !== current) out[key] = value === '' ? null : value;
  }
  return out as Partial<IdentityText>;
}

export function textOf(draft: Draft): IdentityText {
  const v = (s: string): string | null => (s.trim() === '' ? null : s.trim());
  return {
    name_ar: v(draft.name_ar),
    name_en: v(draft.name_en),
    primary_color: v(draft.primary_color),
    secondary_color: v(draft.secondary_color),
    phone: v(draft.phone),
    whatsapp: v(draft.whatsapp),
    email: v(draft.email),
    website: v(draft.website),
    address_ar: v(draft.address_ar),
    address_en: v(draft.address_en),
    instagram: v(draft.instagram),
    facebook: v(draft.facebook),
    tiktok: v(draft.tiktok),
  };
}

export function fieldErrors(t: Translator, error: unknown): Readonly<Record<string, string>> {
  if (!(error instanceof ApiError)) return { form: t('brand.error.save') };
  const fields = Object.keys(error.fields);
  if (fields.length === 0) return { form: error.status === 403 ? t('brand.error.forbidden') : t('brand.error.save') };
  const kind = (f: string): string =>
    f.includes('color')
      ? 'color'
      : f === 'email'
        ? 'email'
        : ['website', 'instagram', 'facebook', 'tiktok'].includes(f)
          ? 'url'
          : ['phone', 'whatsapp'].includes(f)
            ? 'phone'
            : 'text';
  return Object.fromEntries(fields.map((f) => [f, t(`brand.error.field_${kind(f)}`)]));
}

// ---------------------------------------------------------------------------
// Logo
// ---------------------------------------------------------------------------

interface Pending {
  readonly blob: Blob;
  readonly name: string;
  readonly previewUrl: string;
  readonly thermal: ThermalCopy;
  readonly svg: boolean;
}

export function LogoSection({
  locale,
  identity,
  disabled,
  onChange,
}: {
  readonly locale: Locale;
  readonly identity: Identity;
  readonly disabled: boolean;
  readonly onChange: (identity: Identity) => void;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const input = useRef<HTMLInputElement>(null);
  const [raw, setRaw] = useState<File | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [printLogo, setPrintLogo] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useLogoUrl(locale, identity);
  const currentThermal = useLogoUrl(locale, identity, 'thermal');

  useEffect(
    () => () => {
      if (pending) {
        URL.revokeObjectURL(pending.previewUrl);
        URL.revokeObjectURL(pending.thermal.url);
      }
    },
    [pending],
  );

  const choose = async (file: File): Promise<void> => {
    setError(null);
    if (file.size > MAX_LOGO_BYTES) {
      setError(t('brand.error.logo_too_large'));
      return;
    }
    const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
    if (isSvg) {
      const text = await file.text();
      if (file.size > 512 * 1024 || svgLooksUnsafe(text)) {
        setError(t('brand.error.logo_unsafe_svg'));
        return;
      }
      try {
        const { image, width, height } = await svgImage(text);
        const thermal = await makeThermal(image, width, height);
        const blob = new Blob([text], { type: 'image/svg+xml' });
        setPrintLogo(thermal.suitable);
        setPending({ blob, name: 'logo.svg', previewUrl: URL.createObjectURL(blob), thermal, svg: true });
      } catch {
        setError(t('brand.error.logo_invalid'));
      }
      return;
    }
    if (!['image/png', 'image/jpeg'].includes(file.type)) {
      setError(t('brand.error.logo_type'));
      return;
    }
    setRaw(file);
  };

  const cropped = async (result: { blob: Blob; canvas: HTMLCanvasElement }): Promise<void> => {
    setRaw(null);
    if (result.canvas.width < 64 && result.canvas.height < 64) {
      setError(t('brand.error.logo_too_small'));
      return;
    }
    const thermal = await makeThermal(result.canvas, result.canvas.width, result.canvas.height);
    setPrintLogo(thermal.suitable);
    setPending({ blob: result.blob, name: 'logo.png', previewUrl: URL.createObjectURL(result.blob), thermal, svg: false });
  };

  const upload = async (): Promise<void> => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await uploadLogo(locale, pending.blob, pending.name, pending.thermal.blob, printLogo));
      setPending(null);
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.fields.logo?.includes('too_large')
          ? t('brand.error.logo_too_large')
          : failure instanceof ApiError && failure.status === 403
            ? t('brand.error.forbidden')
            : t('brand.error.logo_invalid'),
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      onChange(await removeLogo(locale));
    } catch {
      setError(t('brand.error.save'));
    } finally {
      setBusy(false);
    }
  };

  if (raw) {
    return (
      <div className="brand-logo">
        <p className="brand-note">{t('brand.logo.crop_help')}</p>
        <PhotoEditor locale={locale} file={raw} mode="logo" onUse={(r) => void cropped(r)} onCancel={() => setRaw(null)} />
      </div>
    );
  }

  return (
    <div className="brand-logo">
      <input
        ref={input}
        type="file"
        accept={ACCEPTED_LOGO}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void choose(file);
        }}
      />
      {pending ? (
        <div className="brand-logo__compare">
          <div>
            <span className="brand-label">{t('brand.logo.preview')}</span>
            <div className="brand-logo__tile brand-logo__tile--checker">
              <img src={pending.previewUrl} alt={t('brand.logo.preview')} />
            </div>
            {pending.svg ? <p className="brand-note">{t('brand.logo.svg_kept')}</p> : null}
          </div>
          <div>
            <span className="brand-label">{t('brand.logo.thermal')}</span>
            <div className="brand-logo__tile brand-logo__tile--paper">
              <img src={pending.thermal.url} alt={t('brand.logo.thermal')} />
            </div>
            <p className={pending.thermal.suitable ? 'brand-note' : 'brand-warn'} role={pending.thermal.suitable ? undefined : 'status'}>
              {t(pending.thermal.suitable ? 'brand.logo.thermal_ok' : pending.thermal.ink < 0.02 ? 'brand.logo.thermal_faint' : 'brand.logo.thermal_dark')}
            </p>
            <label className="brand-check">
              <input type="checkbox" checked={printLogo} onChange={(e) => setPrintLogo(e.target.checked)} />
              <span>{t('brand.logo.print_on_receipts')}</span>
            </label>
          </div>
        </div>
      ) : (
        <div className="brand-logo__current">
          <div className="brand-logo__tile brand-logo__tile--checker">
            {current ? <img src={current} alt={t('brand.logo.current')} /> : <span className="brand-muted">{t('brand.logo.none')}</span>}
          </div>
          <div className="brand-logo__meta">
            <p className="brand-note">{t('brand.logo.help')}</p>
            {identity.logo ? (
              <p className="brand-note">
                {identity.print_logo ? t('brand.logo.receipts_logo') : t('brand.logo.receipts_text')}
              </p>
            ) : null}
            {currentThermal && identity.logo ? (
              <div className="brand-logo__tile brand-logo__tile--paper brand-logo__tile--small">
                <img src={currentThermal} alt={t('brand.logo.thermal')} />
              </div>
            ) : null}
          </div>
        </div>
      )}
      {error ? (
        <p className="brand-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="brand-actions">
        {pending ? (
          <>
            <Button loading={busy} onClick={() => void upload()} disabled={disabled}>
              {t('brand.logo.use')}
            </Button>
            <Button variant="secondary" onClick={() => setPending(null)}>
              {t('brand.cancel')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={() => input.current?.click()} disabled={disabled}>
              {t(identity.logo ? 'brand.logo.replace' : 'brand.logo.upload')}
            </Button>
            {identity.logo ? (
              <Button variant="ghost" loading={busy} onClick={() => void remove()} disabled={disabled}>
                {t('brand.logo.remove')}
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Names, colours, contact
// ---------------------------------------------------------------------------

function ColorField({
  t,
  label,
  value,
  fallback,
  error,
  disabled,
  onChange,
}: {
  readonly t: Translator;
  readonly label: string;
  readonly value: string;
  readonly fallback: string;
  readonly error: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}): React.JSX.Element {
  const shown = isHexColor(value) ? value : fallback;
  const low = isHexColor(value) && contrastRatio(value, '#FFFFFF') < 3;
  return (
    <Field label={label} {...(error ? { error } : low ? { helper: t('brand.color.low_contrast') } : {})}>
      <span className="brand-color">
        <input
          type="color"
          value={shown.toLowerCase()}
          aria-label={label}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
        />
        <Input value={value} placeholder={fallback} dir="ltr" maxLength={7} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      </span>
    </Field>
  );
}

type Setter = (key: keyof Draft, value: string) => void;

export function DetailsFields({
  locale,
  draft,
  errors,
  disabled,
  set,
}: {
  readonly locale: Locale;
  readonly draft: Draft;
  readonly errors: Readonly<Record<string, string>>;
  readonly disabled: boolean;
  readonly set: Setter;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const err = (k: string): { error: string } | Record<string, never> => (errors[k] ? { error: errors[k] } : {});
  return (
    <div className="brand-form">
      <div className="brand-form__row">
        <Field label={t('brand.field.name_ar')} {...err('name_ar')}>
          <Input value={draft.name_ar} dir="rtl" lang="ar" maxLength={120} disabled={disabled} onChange={(e) => set('name_ar', e.target.value)} />
        </Field>
        <Field label={t('brand.field.name_en')} {...err('name_en')}>
          <Input value={draft.name_en} dir="ltr" lang="en" maxLength={120} disabled={disabled} onChange={(e) => set('name_en', e.target.value)} />
        </Field>
      </div>
      <div className="brand-form__row">
        <ColorField t={t} label={t('brand.field.primary_color')} value={draft.primary_color} fallback={DEFAULT_PRIMARY} error={errors.primary_color} disabled={disabled} onChange={(v) => set('primary_color', v)} />
        <ColorField t={t} label={t('brand.field.secondary_color')} value={draft.secondary_color} fallback={DEFAULT_SECONDARY} error={errors.secondary_color} disabled={disabled} onChange={(v) => set('secondary_color', v)} />
      </div>
    </div>
  );
}

export function ContactFields({
  locale,
  draft,
  errors,
  disabled,
  set,
}: {
  readonly locale: Locale;
  readonly draft: Draft;
  readonly errors: Readonly<Record<string, string>>;
  readonly disabled: boolean;
  readonly set: Setter;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const field = (key: keyof Draft, props: React.InputHTMLAttributes<HTMLInputElement> = {}): React.JSX.Element => (
    <Field label={t(`brand.field.${key}`)} {...(errors[key] ? { error: errors[key] } : {})}>
      <Input value={draft[key]} disabled={disabled} onChange={(e) => set(key, e.target.value)} {...props} />
    </Field>
  );
  return (
    <div className="brand-form">
      <div className="brand-form__row">
        {field('phone', { dir: 'ltr', inputMode: 'tel', maxLength: 40 })}
        {field('whatsapp', { dir: 'ltr', inputMode: 'tel', maxLength: 40 })}
      </div>
      <div className="brand-form__row">
        {field('email', { dir: 'ltr', type: 'email', maxLength: 254 })}
        {field('website', { dir: 'ltr', inputMode: 'url', maxLength: 300, placeholder: 'example.com' })}
      </div>
      <div className="brand-form__row">
        {field('address_ar', { dir: 'rtl', maxLength: 300 })}
        {field('address_en', { dir: 'ltr', maxLength: 300 })}
      </div>
      <div className="brand-form__row brand-form__row--3">
        {field('instagram', { dir: 'ltr', inputMode: 'url', maxLength: 300, placeholder: 'instagram.com/…' })}
        {field('facebook', { dir: 'ltr', inputMode: 'url', maxLength: 300, placeholder: 'facebook.com/…' })}
        {field('tiktok', { dir: 'ltr', inputMode: 'url', maxLength: 300, placeholder: 'tiktok.com/@…' })}
      </div>
    </div>
  );
}

/** The live preview: the brand header as documents show it, and the receipt on both paper widths. */
export function PreviewPanel({
  locale,
  identity,
  draft,
}: {
  readonly locale: Locale;
  readonly identity: Identity;
  readonly draft: Draft;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const [paper, setPaper] = useState<58 | 80>(80);
  const logo = useLogoUrl(locale, identity);
  const thermal = useLogoUrl(locale, identity, 'thermal');
  const text = textOf(draft);
  const primary = text.primary_color ?? DEFAULT_PRIMARY;
  const secondary = text.secondary_color ?? DEFAULT_SECONDARY;
  const name = (locale === 'ar' ? (text.name_ar ?? text.name_en) : (text.name_en ?? text.name_ar)) ?? identity.company_name;
  return (
    <div className="brand-preview">
      <span className="brand-label">{t('brand.preview.header')}</span>
      <div className="brand-preview__header" style={{ borderBlockStartColor: primary }}>
        {logo ? <img src={logo} alt="" /> : null}
        <div>
          <strong style={{ color: secondary }}>{name}</strong>
          {text.phone ? <span dir="ltr">{text.phone}</span> : null}
        </div>
        <span className="brand-preview__chip" style={{ background: primary }}>
          {t('brand.preview.button')}
        </span>
      </div>
      <div className="brand-preview__paper" role="group" aria-label={t('brand.preview.paper')}>
        <span className="brand-label">{t('brand.preview.receipt')}</span>
        <span className="brand-toggle">
          {([80, 58] as const).map((p) => (
            <button key={p} type="button" aria-pressed={paper === p} onClick={() => setPaper(p)}>
              {t('brand.preview.mm', { mm: String(p) })}
            </button>
          ))}
        </span>
      </div>
      <ReceiptPreview
        locale={locale}
        identity={text}
        companyName={identity.company_name}
        thermalUrl={thermal}
        printLogo={identity.print_logo}
        paper={paper}
      />
    </div>
  );
}
