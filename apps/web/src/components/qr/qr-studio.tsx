'use client';

/**
 * QR Studio — dynamic, branded QR codes, one of 1to1OS’s products (its own page, /qr).
 *
 * An ordinary 1to1OS screen: the page heading, the three views as tabs (a new code, the
 * company's codes, their statistics), then the studio itself. The studio's engine
 * (`public/qr-studio/engine.js` — the code builder, its designs and exports, and the
 * landing pages a scan opens) runs inside a shadow root under the tabs. 1to1OS's own
 * stylesheets are copied into that root beside the studio's, so the studio is drawn with
 * the product's buttons, fields, cards, fonts and theme colours and follows the theme
 * picker, while the landing-page templates cannot reach the rest of the product.
 *
 * Sign-in, language and theme are 1to1OS's; the codes are saved through the API's `/qr`
 * endpoints. A code's own design and landing page are the customer's and keep their look.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Locale } from '@ufuq/i18n';

import { API_BASE_PATH, API_ORIGIN, fetchOne } from '../../lib/api-client';
import { useResource } from '../settings/use-resource';

interface MePayload {
  readonly user: { readonly id: string; readonly email: string };
  readonly company: { readonly name: string };
}

type StudioView = 'new' | 'list' | 'stats';

interface StudioHandle {
  show(view: StudioView): void;
}

interface StudioOptions {
  readonly lang: Locale;
  readonly api: string;
  readonly user: string;
  readonly email: string;
  readonly name: string;
  readonly onView: (view: string) => void;
  readonly onCount: (count: number) => void;
  readonly onSessionEnd: () => void;
}

declare global {
  interface Window {
    QrStudio?: { mount(root: ShadowRoot, options: StudioOptions): Promise<StudioHandle> };
  }
}

const ENGINE_SRC = '/qr-studio/engine.js';
const STUDIO_CSS = '/qr-studio/studio.css';
const VIEWS: readonly StudioView[] = ['new', 'list', 'stats'];

let engine: Promise<void> | null = null;

/** The studio engine, loaded once per page. */
function loadEngine(): Promise<void> {
  if (window.QrStudio) return Promise.resolve();
  engine ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = ENGINE_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      engine = null;
      script.remove();
      reject(new Error('QR Studio engine did not load'));
    };
    document.head.appendChild(script);
  });
  return engine;
}

/** A stylesheet link that settles when it has loaded (or failed). */
function stylesheet(href: string): {
  readonly node: HTMLLinkElement;
  readonly ready: Promise<void>;
} {
  const node = document.createElement('link');
  node.rel = 'stylesheet';
  node.href = href;
  const ready = new Promise<void>((resolve) => {
    node.onload = () => resolve();
    node.onerror = () => resolve();
  });
  return { node, ready };
}

/**
 * 1to1OS's stylesheets, copied into the studio's shadow root so its markup can use the
 * product's own classes (`.button`, `.card`, …) and element styles. The theme itself is
 * custom properties on `<html>`, which reach into the root on their own.
 */
function productStyles(): { readonly nodes: Node[]; readonly ready: Promise<void>[] } {
  const nodes: Node[] = [];
  const ready: Promise<void>[] = [];
  document.head.querySelectorAll('link[rel="stylesheet"], style').forEach((element) => {
    if (element instanceof HTMLLinkElement) {
      if (element.id === 'qrs-fonts') return;
      const copy = stylesheet(element.href);
      nodes.push(copy.node);
      ready.push(copy.ready);
    } else {
      nodes.push(element.cloneNode(true));
    }
  });
  return { nodes, ready };
}

function viewFromHash(): StudioView {
  const hash = typeof window === 'undefined' ? '' : window.location.hash.slice(1);
  return (VIEWS as readonly string[]).includes(hash) ? (hash as StudioView) : 'new';
}

export function QrStudio({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const ar = locale === 'ar';
  const load = useCallback(
    (signal: AbortSignal) => fetchOne<MePayload>('/auth/me', { locale, signal }),
    [locale],
  );
  const me = useResource(load);
  const host = useRef<HTMLDivElement>(null);
  const studio = useRef<StudioHandle | null>(null);
  const [view, setView] = useState<StudioView>('new');
  const [count, setCount] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  const account = me.state.status === 'ready' ? me.state.value : null;
  const userId = account?.user.id ?? '';
  const email = account?.user.email ?? '';
  const company = account?.company.name ?? '';

  useEffect(() => {
    const element = host.current;
    if (element === null || userId === '') return;
    let cancelled = false;
    const root = element.shadowRoot ?? element.attachShadow({ mode: 'open' });
    root.replaceChildren();
    setFailed(false);

    const product = productStyles();
    const own = stylesheet(STUDIO_CSS);
    root.append(...product.nodes, own.node);

    void (async () => {
      try {
        await Promise.all([loadEngine(), own.ready, ...product.ready]);
        if (cancelled || !window.QrStudio) return;
        const handle = await window.QrStudio.mount(root, {
          lang: locale,
          // Where the studio saves codes and uploads files: the same API this screen uses.
          api: new URL(API_BASE_PATH, API_ORIGIN).toString(),
          user: userId,
          email,
          name: company,
          onView: (next) => {
            if ((VIEWS as readonly string[]).includes(next)) setView(next as StudioView);
          },
          onCount: setCount,
          // The session ended: reloading takes 1to1OS back to its sign-in.
          onSessionEnd: () => window.location.reload(),
        });
        if (cancelled) return;
        studio.current = handle;
        const first = viewFromHash();
        if (first !== 'new') handle.show(first);
      } catch (error) {
        console.error(error);
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      studio.current = null;
      root.replaceChildren();
    };
  }, [locale, userId, email, company]);

  const title = ar ? 'استوديو QR' : 'QR Studio';
  const description = ar
    ? 'اعمل أكواد QR بهوية شركتك، عدّل محتواها بعد الطباعة، وتابع المسحات.'
    : 'Create QR codes in your brand, change what they point to after printing, and follow the scans.';
  const tabs: readonly [StudioView, string][] = [
    ['new', ar ? 'كود جديد' : 'New code'],
    ['list', ar ? 'أكوادي' : 'My codes'],
    ['stats', ar ? 'الإحصائيات' : 'Statistics'],
  ];

  const open = (next: StudioView) => (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}${next === 'new' ? '' : `#${next}`}`,
    );
    setView(next);
    studio.current?.show(next);
    window.scrollTo({ top: 0 });
  };

  const status =
    me.state.status === 'error' || failed
      ? ar
        ? 'تعذر تحميل استوديو QR. حدّث الصفحة وحاول تاني.'
        : 'QR Studio could not load. Refresh the page and try again.'
      : me.state.status === 'loading'
        ? ar
          ? 'جاري تحميل استوديو QR…'
          : 'Loading QR Studio…'
        : null;

  return (
    <div className="tasks-page qr-studio">
      <header className="page-heading">
        <div>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
      </header>
      <nav className="tabs" aria-label={title}>
        {tabs.map(([key, label]) => (
          <a
            key={key}
            href={`#${key}`}
            className={key === view ? 'is-active' : ''}
            {...(key === view ? { 'aria-current': 'page' as const } : {})}
            onClick={open(key)}
          >
            {label}
            {key === 'list' && count !== null ? (
              <span className="qr-studio__count" dir="ltr">
                {count}
              </span>
            ) : null}
          </a>
        ))}
      </nav>
      {status === null ? null : (
        <p className="qr-studio__status" role={failed ? 'alert' : 'status'}>
          {status}
        </p>
      )}
      <div ref={host} className="qr-studio__host" aria-busy={me.state.status === 'loading'} />
    </div>
  );
}
