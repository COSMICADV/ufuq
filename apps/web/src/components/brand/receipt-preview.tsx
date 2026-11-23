'use client';

import { createTranslator, formatMoney } from '@ufuq/i18n';
import type { Locale } from '@ufuq/i18n';

import { displayName } from '../../lib/brand';
import type { IdentityText } from '../../lib/brand';

/**
 * How a thermal receipt will look with this identity — the layout POS
 * receipts will use. The logo prints only from its black-and-white copy and
 * only when it prints well; otherwise the business name prints as text.
 * The items are a sample, labelled as such.
 */
export function ReceiptPreview({
  locale,
  identity,
  companyName,
  thermalUrl,
  printLogo,
  paper,
}: {
  readonly locale: Locale;
  readonly identity: IdentityText;
  readonly companyName: string;
  readonly thermalUrl: string | null;
  readonly printLogo: boolean;
  readonly paper: 58 | 80;
}): React.JSX.Element {
  const t = createTranslator(locale);
  const name = displayName({ ...identity, company_name: companyName }, locale);
  const other = locale === 'ar' ? identity.name_en : identity.name_ar;
  const address = locale === 'ar' ? (identity.address_ar ?? identity.address_en) : (identity.address_en ?? identity.address_ar);
  const money = (amount: string): string => formatMoney(amount, 'EGP', { locale });
  const items: readonly (readonly [string, number, string])[] = [
    [t('brand.receipt.sample_item_1'), 2, '90.00'],
    [t('brand.receipt.sample_item_2'), 1, '65.00'],
  ];
  const showLogo = printLogo && thermalUrl !== null;
  return (
    <figure className={`receipt receipt--${String(paper)}`} aria-label={t('brand.receipt.label', { paper: String(paper) })}>
      <div className="receipt__paper">
        <header className="receipt__head">
          {showLogo ? <img src={thermalUrl} alt="" className="receipt__logo" /> : null}
          <strong className="receipt__name">{name}</strong>
          {other && other !== name ? <span className="receipt__alt">{other}</span> : null}
          {address ? <span>{address}</span> : null}
          {identity.phone ? <span dir="ltr">{identity.phone}</span> : null}
        </header>
        <div className="receipt__rule" />
        <dl className="receipt__lines">
          {items.map(([label, qty, price]) => (
            <div key={label}>
              <dt>
                {label} <span dir="ltr">×{qty}</span>
              </dt>
              <dd dir="ltr">{money(price)}</dd>
            </div>
          ))}
        </dl>
        <div className="receipt__rule" />
        <dl className="receipt__lines receipt__total">
          <div>
            <dt>{t('brand.receipt.total')}</dt>
            <dd dir="ltr">{money('245.00')}</dd>
          </div>
        </dl>
        <div className="receipt__rule" />
        <footer className="receipt__foot">
          <span>{t('brand.receipt.thanks')}</span>
          {identity.whatsapp ? <span dir="ltr">WhatsApp {identity.whatsapp}</span> : null}
          {identity.website ? <span dir="ltr">{identity.website.replace(/^https?:\/\//, '')}</span> : null}
        </footer>
      </div>
      <figcaption>
        {t('brand.receipt.caption', { paper: String(paper) })} · {t('brand.receipt.sample')}
      </figcaption>
    </figure>
  );
}
