'use client';
import { containDialogFocus } from '../lib/dialog-focus';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Locale } from '@ufuq/i18n';

import { ProductLogo } from './brand-mark';
import { FreehandIcon } from './freehand-icon';
import { NavGlyph } from './nav-glyph';
import type { NavGlyphName } from './nav-glyph';
import { AppTopbar } from './notifications/app-topbar';
import { createTranslator } from '@ufuq/i18n';
import { LanguageSwitch } from './language-switch';
import { languageNames } from '../lib/language-names';
import { SignOutButton } from './sign-out-button';
import { ThemePicker } from './theme-picker';
import { loadSession } from './employees/use-session';
import { useResource } from './settings/use-resource';
import { publicPath } from '../lib/public-content';
import { personalBase } from '../lib/personal';
import { loadMedicalMe } from '../lib/medical';
import { displayName } from '../lib/brand';
import { useIdentity, useLogoUrl } from './brand/use-identity';
import type { MedicalMe } from '../lib/medical';

const navigation = [
  ['', 'الرئيسية', 'Overview', 'M3 11 12 3l9 8v10h-6v-7H9v7H3Z', 'report.company', 'report.team'],
  [
    'employees',
    'الموظفون',
    'Employees',
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-4M16 3a4 4 0 0 1 0 8',
    'employee.view',
  ],
  [
    'attendance',
    'الحضور',
    'Attendance',
    'M12 8v4l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
    'attendance.view',
  ],
  [
    'tasks',
    'المهام',
    'Tasks',
    'M9 6h12M9 12h12M9 18h12M3 6l1 1 2-3M3 12l1 1 2-3M3 18l1 1 2-3',
    'task.view',
  ],
  [
    'goals',
    'الأهداف والأداء',
    'Goals',
    'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M18 12a6 6 0 1 1-12 0 6 6 0 0 1 12 0M14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
    'goal.view',
  ],
  [
    'requests',
    'الطلبات',
    'Requests',
    'M7 3h10v4H7ZM7 5H4v16h16V5h-3M8 12h8M8 16h5',
    'request.view',
    'request.create',
    'request.review',
  ],
  [
    'requests?category=leave',
    'الإجازات',
    'Leave',
    'M4 5h16v16H4ZM8 3v4M16 3v4M4 11h16M8 15h3',
    'leave.view',
    'leave.request',
  ],
  ['payroll', 'الرواتب', 'Payroll', 'M3 5h18v14H3ZM3 9h18M7 15h3', 'payroll.view'],
  [
    'reports',
    'التقارير',
    'Reports',
    'M4 3v18h17M8 16v-4M13 16V8M18 16V5',
    'report.company',
    'report.team',
  ],
  [
    'warehouse',
    'المخازن',
    'Warehouse',
    'M3 9l9-6 9 6v12H3ZM7 21V11h10v10M7 15h10',
    'warehouse.view',
  ],
  [
    'inventory',
    'المخزون',
    'Inventory',
    'm12 3 9 5v9l-9 5-9-5V8ZM3 8l9 5 9-5M12 13v9',
    'product.view',
    'stock.view',
  ],
  [
    'notifications',
    'الإشعارات',
    'Notifications',
    'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
  ],
  [
    'settings/company',
    'الإعدادات',
    'Settings',
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z',
    'settings.update',
    'settings.view',
    'audit.view',
  ],
] as const;

/**
 * Medical sections — shown only to a company whose activity is medical, and
 * only to someone the admin granted (GET /medical/me), never by company role.
 */
const MEDICAL_NAV = [
  ['queue', 'M4 5h16M4 12h10M4 19h7M17 14l3 3-3 3M14 17h6'],
  ['patients', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4 21v-1a6 6 0 0 1 9-5.2M18 14v7M14.5 17.5h7'],
  ['medical-team', 'M6 3v5a4 4 0 0 0 8 0V3M10 12v3a5 5 0 0 0 10 0v-2M20 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4'],
] as const;

/** The catalogue key (`shell.nav.*`) of each section's label. */
function navKey(path: string, surface: 'admin' | 'app'): string {
  if (path === '') return surface === 'app' ? 'home' : 'overview';
  if (path === 'medical-team') return 'medical_team';
  if (path.startsWith('requests?category=leave')) return 'leave';
  if (path.startsWith('settings')) return 'settings';
  return path;
}

/** The icon each section is drawn with (the paths above stay as the fallback). */
const NAV_ICONS: Readonly<Record<string, NavGlyphName>> = {
  '': 'overview',
  employees: 'employees',
  attendance: 'attendance',
  tasks: 'tasks',
  goals: 'goals',
  requests: 'requests',
  'requests?category=leave': 'leave',
  payroll: 'payroll',
  reports: 'reports',
  warehouse: 'warehouse',
  inventory: 'inventory',
  notifications: 'notifications',
  'settings/company': 'settings',
  salary: 'payroll',
};

function NavIcon({
  path,
  section,
}: {
  readonly path: string;
  readonly section?: string;
}): React.JSX.Element {
  const glyph = section === undefined ? undefined : NAV_ICONS[section];
  if (glyph !== undefined) return <NavGlyph name={glyph} size={24} />;
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

/** Navigation only reads the existing session; screen/API authorization remains authoritative. */
export function ProductShell({
  locale,
  surface,
  children,
}: {
  readonly locale: Locale;
  readonly surface: 'admin' | 'app';
  readonly children: ReactNode;
}): React.JSX.Element {
  const pathname = usePathname();
  const drawer = useRef<HTMLDialogElement>(null);
  const load = useCallback((signal: AbortSignal) => loadSession(locale, signal), [locale]);
  const session = useResource(load);
  const ready = session.state.status === 'ready' ? session.state.value : null;
  const router = useRouter();
  const [medical, setMedical] = useState<MedicalMe | null>(null);
  const companyUser = ready !== null && ready.roleKey !== 'personal';
  useEffect(() => {
    if (!companyUser) return;
    const controller = new AbortController();
    loadMedicalMe(locale, controller.signal).then(setMedical, () => {
      // No medical section is a safe answer to any failure.
    });
    return () => {
      controller.abort();
    };
  }, [companyUser, locale]);
  // The business's own logo and name in the sidebar, and the restaurant
  // branding step for an admin who has not done or skipped it yet.
  const identity = useIdentity(locale, companyUser);
  const brandLogo = useLogoUrl(locale, identity);
  useEffect(() => {
    if (surface !== 'admin' || !identity?.onboarding.pending) return;
    if (pathname.includes('/admin/setup/')) return;
    router.replace(`/${locale}/admin/setup/branding`);
  }, [surface, identity?.onboarding.pending, pathname, router, locale]);
  // No session at all (never signed in, signed out, or expired): the workspace
  // has nothing to show, so go to sign-in rather than render an empty shell
  // whose every screen says "session ended".
  const signedOut = session.state.status === 'error' && session.state.error.isUnauthenticated;
  // An employee who opens the business workspace (a bookmark, a shared link,
  // a browser still signed in as them) belongs on their own side: every admin
  // screen would only answer "you do not have permission".
  const wrongSide = surface === 'admin' && ready?.roleKey === 'employee';
  // A 1to1OS Personal account has no Business workspace; its own is /personal.
  const personal = ready?.roleKey === 'personal';
  useEffect(() => {
    if (signedOut) router.replace(publicPath(locale, 'login'));
    else if (personal) router.replace(personalBase(locale));
    else if (wrongSide) router.replace(`/${locale}/app`);
  }, [signedOut, personal, wrongSide, router, locale]);
  const t = createTranslator(locale);
  const base = `/${locale}/${surface}`;
  const close = (): void => {
    drawer.current?.close();
  };
  const open = (): void => {
    drawer.current?.showModal();
  };
  const items = navigation.filter(([path, , , , ...permissions]) => {
    if (ready === null) return path === '' || path === 'notifications';
    if (surface === 'app') {
      if (['employees', 'warehouse', 'inventory', 'settings/company', 'payroll'].includes(path))
        return false;
      if (path === '' || path === 'reports' || path === 'attendance') return true;
    }
    return (
      permissions.length === 0 ||
      permissions.some((permission) => ready.permissions.has(permission))
    );
  });
  const links = items.map(([path, , , icon]) => {
    const href = `${base}${path ? `/${path}` : ''}`;
    const current =
      path === 'settings/company'
        ? pathname.startsWith(`${base}/settings/`)
        : path === ''
          ? pathname === base
          : !path.includes('?') && (pathname === href || pathname.startsWith(`${href}/`));
    return (
      <Link key={path} href={href} onClick={close} aria-current={current ? 'page' : undefined}>
        <NavIcon path={icon} section={path} />
        <span>{t(`shell.nav.${navKey(path, surface)}`)}</span>
      </Link>
    );
  });
  const medicalLinks = MEDICAL_NAV.filter(([path]) =>
    medical?.enabled
      ? path === 'queue'
        ? medical.permissions['visits.view'] !== undefined
        : path === 'patients'
          ? medical.permissions['patients.view'] !== undefined
          : medical.permissions['staff.manage'] !== undefined
      : false,
  ).map(([path, icon]) => {
    const href = `${base}/${path}`;
    const current = pathname === href || pathname.startsWith(`${href}/`);
    return (
      <Link key={path} href={href} onClick={close} aria-current={current ? 'page' : undefined}>
        <NavIcon path={icon} />
        <span>{t(`shell.nav.${navKey(path, surface)}`)}</span>
      </Link>
    );
  });
  const salary =
    surface === 'app' &&
    ready?.employeeId &&
    ready.permissions.has('payroll.view') &&
    ready.permissions.has('employee.view_salary') ? (
      <Link
        href={`${base}/salary`}
        onClick={close}
        aria-current={pathname.startsWith(`${base}/salary`) ? 'page' : undefined}
      >
        <NavIcon path={navigation[7][3]} section="salary" />
        <span>{t('shell.my_salary')}</span>
      </Link>
    ) : null;
  const branding = (
    <Link href={base} className="product-brand" onClick={close}>
      <span>
        <ProductLogo product="Business" />
        <small>
          {t(surface === 'admin' ? 'shell.workspace_admin' : 'shell.workspace_employee')}
        </small>
      </span>
    </Link>
  );
  return (
    <div className={`product-shell product-shell--${surface}`}>
      <a className="public-skip" href="#workspace-content">
        {t('shell.skip')}
      </a>
      <aside className="product-sidebar">
        {branding}
        <nav className="product-nav" aria-label={t('shell.main_nav')}>
          {links.slice(0, 1)}
          {medicalLinks}
          {links.slice(1)}
          {salary}
        </nav>
        <p className="product-company">
          <span className="product-company__icon">
            {brandLogo ? (
              <img src={brandLogo} alt="" className="product-company__logo" />
            ) : (
              <FreehandIcon name="building" size={20} />
            )}
          </span>
          <span>{identity ? displayName(identity, locale) : (ready?.companyName ?? t('shell.tagline'))}</span>
        </p>
      </aside>
      <div className="product-workspace">
        <header className="product-header">
          <button
            className="icon-button product-menu"
            onClick={open}
            aria-label={t('shell.open_nav')}
            aria-haspopup="dialog"
          >
            <FreehandIcon name="menu" size={24} />
          </button>
          <AppTopbar locale={locale} surface={surface} />
        </header>
        <div id="workspace-content" tabIndex={-1} className="product-content">
          {children}
        </div>
      </div>
      <dialog
        ref={drawer}
        onKeyDown={containDialogFocus}
        className="product-drawer"
        aria-label={t('shell.nav_menu')}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <div className="product-drawer__body">
          <div className="product-drawer__heading">
            {branding}
            <button className="icon-button" onClick={close} aria-label={t('shell.close_menu')}>
              <FreehandIcon name="close" size={22} />
            </button>
          </div>
          <nav className="product-nav" aria-label={t('shell.all_sections')}>
            {links.slice(0, 1)}
            {medicalLinks}
            {links.slice(1)}
            {salary}
          </nav>
          <div className="product-drawer__prefs">
            <LanguageSwitch locale={locale} label={t('language.switch')} names={languageNames(t)} />
            <ThemePicker locale={locale} />
            <SignOutButton locale={locale} />
          </div>
        </div>
      </dialog>
      <nav className="product-bottom" aria-label={t('shell.quick_nav')}>
        {items
          .filter(([p]) =>
            (surface === 'app'
              ? ['', 'attendance', 'tasks', 'requests']
              : ['', 'employees', 'tasks', 'requests']
            ).includes(p),
          )
          .map(([path, , , icon]) => (
            <Link
              key={path}
              href={`${base}${path ? `/${path}` : ''}`}
              aria-current={pathname === `${base}${path ? `/${path}` : ''}` ? 'page' : undefined}
            >
              <NavIcon path={icon} section={path} />
              <span>{t(`shell.nav.${navKey(path, surface)}`)}</span>
            </Link>
          ))}
        <button onClick={open} aria-haspopup="dialog">
          <FreehandIcon name="more" size={22} />
          <span>{t('shell.more')}</span>
        </button>
      </nav>
    </div>
  );
}
