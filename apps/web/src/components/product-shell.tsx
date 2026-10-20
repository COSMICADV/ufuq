'use client';
import { containDialogFocus } from '../lib/dialog-focus';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useRef } from 'react';
import type { ReactNode } from 'react';
import type { Locale } from '@ufuq/i18n';

import { BrandMark } from './brand-mark';
import { AppTopbar } from './notifications/app-topbar';
import { loadSession } from './employees/use-session';
import { useResource } from './settings/use-resource';

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

function NavIcon({ path }: { readonly path: string }): React.JSX.Element {
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
  const ar = locale === 'ar';
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
  const links = items.map(([path, arabic, english, icon]) => {
    const href = `${base}${path ? `/${path}` : ''}`;
    const current =
      path === 'settings/company'
        ? pathname.startsWith(`${base}/settings/`)
        : path === ''
          ? pathname === base
          : !path.includes('?') && (pathname === href || pathname.startsWith(`${href}/`));
    return (
      <Link key={path} href={href} onClick={close} aria-current={current ? 'page' : undefined}>
        <NavIcon path={icon} />
        <span>{ar ? arabic : surface === 'app' && path === '' ? 'Home' : english}</span>
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
        <NavIcon path={navigation[7][3]} />
        <span>{ar ? 'راتبي' : 'My salary'}</span>
      </Link>
    ) : null;
  const branding = (
    <Link href={base} className="product-brand" onClick={close}>
      <BrandMark />
      <span>
        {ar ? 'أُفق' : 'UFUQ'}
        <small>
          {surface === 'admin'
            ? ar
              ? 'إدارة الأعمال'
              : 'Business workspace'
            : ar
              ? 'مساحة الموظف'
              : 'Employee workspace'}
        </small>
      </span>
    </Link>
  );
  return (
    <div className={`product-shell product-shell--${surface}`}>
      <a className="public-skip" href="#workspace-content">
        {ar ? 'انتقل إلى المحتوى' : 'Skip to content'}
      </a>
      <aside className="product-sidebar">
        {branding}
        <nav className="product-nav" aria-label={ar ? 'التنقل الرئيسي' : 'Main navigation'}>
          {links}
          {salary}
        </nav>
        <p className="product-company">
          {ready?.companyName ?? (ar ? 'اتجاه واضح. عمل أفضل.' : 'Clear direction. Better work.')}
        </p>
      </aside>
      <div className="product-workspace">
        <header className="product-header">
          <button
            className="icon-button product-menu"
            onClick={open}
            aria-label={ar ? 'فتح قائمة التنقل' : 'Open navigation'}
            aria-haspopup="dialog"
          >
            <NavIcon path="M4 6h16M4 12h16M4 18h16" />
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
        aria-label={ar ? 'قائمة التنقل' : 'Navigation menu'}
        onClick={(event) => {
          if (event.target === event.currentTarget) close();
        }}
      >
        <div className="product-drawer__body">
          <div className="product-drawer__heading">
            {branding}
            <button
              className="icon-button"
              onClick={close}
              aria-label={ar ? 'إغلاق القائمة' : 'Close menu'}
            >
              ×
            </button>
          </div>
          <nav className="product-nav" aria-label={ar ? 'كل الأقسام' : 'All sections'}>
            {links}
            {salary}
          </nav>
        </div>
      </dialog>
      {surface === 'app' ? (
        <nav className="product-bottom" aria-label={ar ? 'التنقل السريع' : 'Quick navigation'}>
          {items
            .filter(([p]) => ['', 'attendance', 'tasks', 'requests'].includes(p))
            .map(([path, arabic, english, icon]) => (
              <Link
                key={path}
                href={`${base}${path ? `/${path}` : ''}`}
                aria-current={pathname === `${base}${path ? `/${path}` : ''}` ? 'page' : undefined}
              >
                <NavIcon path={icon} />
                <span>{ar ? arabic : surface === 'app' && path === '' ? 'Home' : english}</span>
              </Link>
            ))}
          <button onClick={open} aria-haspopup="dialog">
            <NavIcon path="M5 12h.01M12 12h.01M19 12h.01" />
            <span>{ar ? 'المزيد' : 'More'}</span>
          </button>
        </nav>
      ) : null}
    </div>
  );
}
