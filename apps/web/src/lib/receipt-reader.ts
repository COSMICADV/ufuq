import { normaliseDigits } from '@ufuq/i18n';

/**
 * Reads the fields a person would type from the text of a receipt — the
 * text the on-device OCR produced. Every value is a *suggestion*: the screen
 * shows it for review and nothing is applied until the person confirms it
 * (OCR errors must never silently change financial data).
 */

export interface ReceiptReading {
  readonly merchant: string | null;
  /** `YYYY-MM-DD`, a real calendar date, or null. */
  readonly date: string | null;
  /** `HH:MM` (24h) when the receipt prints a time. */
  readonly time: string | null;
  /** The receipt's total, `1234.50`, or null. */
  readonly total: string | null;
  /** How the total was found: a labelled total line, or only the largest amount. */
  readonly totalConfidence: 'labelled' | 'guess' | null;
  readonly tax: string | null;
  readonly currency: string | null;
  /** A default expense category key, from the merchant and the receipt's words. */
  readonly categoryKey: string | null;
}

const TOTAL_WORDS = [
  /grand\s*total/i,
  /total\s*(amount|due|egp|le)?/i,
  /amount\s*due/i,
  /net\s*(amount|total)/i,
  /الإجمالي|الاجمالي|إجمالي|اجمالي|الإجمالى|الاجمالى|اجمالى/,
  /المجموع|الصافي|الصافى|المطلوب|المستحق|صافي/,
];
const SUBTOTAL = /sub\s*-?\s*total|قبل\s*الضريبة|المجموع\s*الفرعي/i;
const TAX_WORDS = /\b(vat|tax)\b|ضريبة|القيمة\s*المضافة|ض\.?\s*ق\.?\s*م/i;
const NOT_MERCHANT =
  /invoice|receipt|tax|vat|cashier|date|time|tel|phone|فاتورة|إيصال|ايصال|ضريب|التاريخ|الوقت|تليفون|هاتف|كاشير|رقم|مسلسل|سجل\s*تجاري|بطاقة/i;

const CURRENCIES: readonly (readonly [RegExp, string])[] = [
  [/\bEGP\b|ج\.?\s?م|جنيه|\bL\.?E\b/i, 'EGP'],
  [/\bUSD\b|\$|دولار/i, 'USD'],
  [/\bEUR\b|€|يورو/i, 'EUR'],
  [/\bSAR\b|ر\.?\s?س|ريال\s*سعودي/i, 'SAR'],
  [/\bAED\b|د\.?\s?إ|درهم/i, 'AED'],
  [/\bGBP\b|£|استرليني/i, 'GBP'],
  [/\bKWD\b|د\.?\s?ك|دينار\s*كويتي/i, 'KWD'],
];

/**
 * Merchant and receipt words → a default category key. Checked in order; the
 * first match wins, the merchant line before the rest of the receipt.
 */
const CATEGORY_HINTS: readonly (readonly [string, RegExp])[] = [
  [
    'fuel',
    /بنزين|بنزينة|محطة\s*(وقود|بنزين)|وقود|سولار|أوكتان|اوكتان|octane|petrol|fuel|gas\s*station|wataniya|وطنية|mobil|موبيل|shell|شل|totalenergies|توتال|emarat\s*misr|امارات\s*مصر|chill\s*out|تشيل\s*اوت|misr\s*petroleum|مصر\s*للبترول|gasoline|diesel/i,
  ],
  [
    'health',
    /صيدلي|pharmac|el\s*ezaby|العزبي|seif|سيف|مستشفى|مستشفي|hospital|عيادة|clinic|معمل|laborator|\blab\b|تحاليل|أشعة|اشعة|radiology|dental|أسنان/i,
  ],
  [
    'groceries',
    /سوبر\s*ماركت|سوبرماركت|supermarket|hypermarket|هايبر|carrefour|كارفور|seoudi|سعودي|spinneys|سبينيس|kazyon|كازيون|oscar|أوسكار|gourmet|جورميه|metro\s*market|مترو\s*ماركت|kheir\s*zaman|خير\s*زمان|ragab|رجب|grocery|بقالة|خضار|فاكهة/i,
  ],
  [
    'food',
    /مطعم|restaurant|caf[eé]|كافيه|كافيتريا|coffee|قهوة|starbucks|ستاربكس|kfc|mcdonald|ماكدونالد|burger|برجر|pizza|بيتزا|zooba|زووبا|كشري|koshary|talabat|طلبات|bakery|مخبز|حلواني|sweets/i,
  ],
  [
    'transport',
    /uber|أوبر|اوبر|careem|كريم|didi|ديدي|indrive|taxi|تاكسي|parking|باركينج|جراج|garage\s*fee|toll|كارتة|swvl|سويفل/i,
  ],
  [
    'car_maintenance',
    /صيانة|مركز\s*خدمة|service\s*center|إطارات|اطارات|كاوتش|tires?|tyres?|oil\s*change|تغيير\s*زيت|فلتر|بطارية|car\s*wash|غسيل\s*سيارات|ميكانيكي|mechanic/i,
  ],
  [
    'bills',
    /كهرباء|electricity|مياه|water\s*bill|غاز\s*طبيعي|natural\s*gas|vodafone|فودافون|orange|أورنج|اورنج|etisalat|اتصالات|\bwe\b|المصرية\s*للاتصالات|telecom|internet|انترنت|إنترنت|فاتورة\s*(تليفون|موبايل)/i,
  ],
  [
    'subscriptions',
    /netflix|نتفليكس|spotify|سبوتيفاي|shahid|شاهد|anghami|أنغامي|youtube\s*premium|apple\.com|icloud|google\s*(one|play)|osn|subscription|اشتراك/i,
  ],
  [
    'entertainment',
    /cinema|سينما|vox|فوكس|theater|مسرح|bowling|بولينج|ملاهي|amusement|ticket|تذكرة/i,
  ],
  ['education', /school|مدرسة|university|جامعة|academy|أكاديمية|course|كورس|دورة|مكتبة|bookstore|books/i],
  [
    'shopping',
    /mall|مول|zara|زارا|h&m|defacto|ديفاكتو|lc\s*waikiki|amazon|أمازون|امازون|noon|نون|jumia|جوميا|ikea|ايكيا|b\.tech|بي\s*تك|2b|fashion|ملابس|أحذية|احذية|electronics/i,
  ],
];

/** Every amount-looking number on a line, as `1234.50` strings. */
export function amountsIn(line: string): string[] {
  const text = normaliseDigits(line).replace(/٫/g, '.').replace(/٬/g, ',');
  const found: string[] = [];
  for (const match of text.matchAll(/(?<![\d/:-])(\d{1,3}(?:[,\s]\d{3})+|\d+)(?:[.,](\d{1,2}))?(?![\d/:])/g)) {
    const whole = (match[1] ?? '').replace(/[,\s]/g, '');
    const cents = match[2];
    if (whole.length > 9) continue;
    found.push(cents === undefined ? whole : `${whole}.${cents.padEnd(2, '0')}`);
  }
  return found;
}

function largest(values: readonly string[]): string | null {
  let best: string | null = null;
  for (const value of values) {
    if (best === null || Number(value) > Number(best)) best = value;
  }
  return best;
}

function validDate(year: number, month: number, day: number): string | null {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1) return null;
  return `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The receipt's date: ISO `2026-11-20`, or Egypt's day-first `20/11/2026` and `20-11-26`. */
export function findDate(text: string): string | null {
  const t = normaliseDigits(text);
  const iso = /\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(t);
  if (iso) {
    const found = validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (found) return found;
  }
  for (const match of t.matchAll(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})\b/g)) {
    const raw = Number(match[3]);
    const year = raw < 100 ? 2000 + raw : raw;
    const dayFirst = validDate(year, Number(match[2]), Number(match[1]));
    if (dayFirst) return dayFirst;
    const monthFirst = validDate(year, Number(match[1]), Number(match[2]));
    if (monthFirst) return monthFirst;
  }
  return null;
}

function findTime(text: string): string | null {
  const match = /\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\s*(am|pm|ص|م)?/i.exec(normaliseDigits(text));
  if (!match) return null;
  let hour = Number(match[1]);
  const suffix = match[3]?.toLowerCase();
  if ((suffix === 'pm' || suffix === 'م') && hour < 12) hour += 12;
  if ((suffix === 'am' || suffix === 'ص') && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${match[2] ?? '00'}`;
}

function findMerchant(lines: readonly string[]): string | null {
  for (const line of lines.slice(0, 6)) {
    const letters = line.replace(/[^\p{L}]/gu, '');
    const digits = normaliseDigits(line).replace(/\D/g, '');
    if (letters.length < 3 || digits.length > letters.length || NOT_MERCHANT.test(line)) continue;
    return line.replace(/\s+/g, ' ').trim().slice(0, 80);
  }
  return null;
}

/** A default expense category key for a merchant name and receipt text. */
export function suggestCategory(merchant: string | null, text: string): string | null {
  for (const source of [merchant ?? '', text]) {
    if (!source) continue;
    for (const [key, pattern] of CATEGORY_HINTS) {
      if (pattern.test(source)) return key;
    }
  }
  return null;
}

export function readReceipt(text: string): ReceiptReading {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  let total: string | null = null;
  let totalConfidence: ReceiptReading['totalConfidence'] = null;
  // The last labelled total wins: receipts print sub-totals before the total.
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (SUBTOTAL.test(line) || TAX_WORDS.test(line)) continue;
    if (!TOTAL_WORDS.some((w) => w.test(line))) continue;
    const here = largest(amountsIn(line)) ?? largest(amountsIn(lines[i + 1] ?? ''));
    if (here !== null && Number(here) > 0) {
      total = here;
      totalConfidence = 'labelled';
    }
  }
  if (total === null) {
    const withCents = lines.flatMap((l) => amountsIn(l).filter((a) => a.includes('.')));
    total = largest(withCents);
    totalConfidence = total === null ? null : 'guess';
  }

  let tax: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!TAX_WORDS.test(line)) continue;
    const amounts = amountsIn(line).filter((a) => !/^\d{1,2}$/.test(a) || line.includes('.'));
    const candidate =
      amounts.filter((a) => a.includes('.')).pop() ??
      amounts.pop() ??
      amountsIn(lines[i + 1] ?? '').filter((a) => a.includes('.')).pop() ??
      null;
    if (candidate !== null && (total === null || Number(candidate) < Number(total))) tax = candidate;
  }

  let currency: string | null = null;
  for (const [pattern, code] of CURRENCIES) {
    if (pattern.test(text)) {
      currency = code;
      break;
    }
  }

  const merchant = findMerchant(lines);
  return {
    merchant,
    date: findDate(text),
    time: findTime(text),
    total,
    totalConfidence,
    tax,
    currency,
    categoryKey: suggestCategory(merchant, text),
  };
}
