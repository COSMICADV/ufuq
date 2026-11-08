'use client';

/**
 * The public home page (the "1to1OS" landing design).
 *
 * Self-contained: its styles live in `styles/landing.css`, every class is prefixed `lp-`
 * and scoped under `.lp`, so nothing here leaks into the product screens. The design is
 * English-only and left-to-right, so the root pins `dir="ltr"` and `lang="en"` even when
 * it is served under the Arabic locale.
 */
import Link from 'next/link';
import { useState } from 'react';
import type { Locale } from '@ufuq/i18n';
import { publicPath } from '../../lib/public-content';
import {
  ArrowRight,
  Building2,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  Cpu,
  Globe,
  Lock,
  Menu,
  PieChart,
  QrCode,
  Receipt,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Users,
  Wallet,
  X,
  Zap,
} from './landing-icons';

type Pillar = 'erp' | 'finance' | 'qr';

const NAV = [
  ['#products', 'Products'],
  ['#features', 'Architecture'],
  ['#pricing', 'Pricing'],
  ['#security', 'Security'],
] as const;

const PILLARS: readonly {
  readonly id: Pillar;
  readonly tone: string;
  readonly icon: (p: React.SVGProps<SVGSVGElement>) => React.JSX.Element;
  readonly title: string;
  readonly body: string;
  readonly points: readonly string[];
  readonly cta: string;
}[] = [
  {
    id: 'erp',
    tone: 'blue',
    icon: Building2,
    title: '1to1 Business ERP',
    body: 'Streamline invoicing, client relationship management (CRM), expense tracking, and real-time inventory control.',
    points: [
      'Automated Recurring Invoices',
      'Multi-Currency Accounting',
      'Vendor & Expense Tracking',
    ],
    cta: 'Explore ERP Features',
  },
  {
    id: 'finance',
    tone: 'emerald',
    icon: Wallet,
    title: 'Personal Wealth OS',
    body: 'Take command of your personal finances with smart budgeting, daily expense logs, savings trackers, and goal metrics.',
    points: ['Flexible Budget Categories', 'Savings Goal Calculators', 'Daily Expense Analytics'],
    cta: 'Explore Personal Finance',
  },
  {
    id: 'qr',
    tone: 'purple',
    icon: QrCode,
    title: 'Professional QR Studio',
    body: 'Generate high-converting, fully customized dynamic QR codes for menus, Wi-Fi, digital business cards, and campaigns.',
    points: ['Dynamic Target URLs', 'Custom Branding & Colors', 'Real-time Scan Analytics'],
    cta: 'Explore QR Studio',
  },
];

/** The decorative 5×5 QR mock: d = dark, a = accent, l = light grey, w = white. */
const QR_CELLS = 'dddld' + 'dwdad' + 'ddddl' + 'laddd' + 'ddldd';

const QR_CLASS: Record<string, string> = {
  d: 'lp-qr__cell--dark',
  a: 'lp-qr__cell--accent',
  l: 'lp-qr__cell--light',
  w: 'lp-qr__cell--white',
};

function Logo(): React.JSX.Element {
  return (
    <svg
      className="lp-logo__glyph"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 12h16" />
      <path d="M7 6v12" />
      <path d="M17 6v12" />
      <path d="M7 12a5 5 0 0 1 10 0" />
    </svg>
  );
}

function Tick({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <li>
      <Check className="lp-tick" />
      {children}
    </li>
  );
}

export function LandingPage({ locale }: { readonly locale: Locale }): React.JSX.Element {
  const [isAnnual, setIsAnnual] = useState(true);
  const [activeTab, setActiveTab] = useState<Pillar>('erp');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [copiedQr, setCopiedQr] = useState(false);
  const [demoQrText, setDemoQrText] = useState('https://1to1os.com');
  const [activeDashboardTab, setActiveDashboardTab] = useState<'overview' | 'finance' | 'qr'>(
    'overview',
  );

  /** Open a product's tab in the hero preview and bring the preview into view. */
  const showPreview = (pillar: Pillar): void => {
    setActiveTab(pillar);
    setActiveDashboardTab(pillar === 'erp' ? 'overview' : pillar);
    document.getElementById('preview')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const loginHref = publicPath(locale, 'login');
  const employeeLoginHref = `${loginHref}?as=employee`;
  const registerHref = publicPath(locale, 'register');
  const contactHref = publicPath(locale, 'contact');

  const handleCopyLink = (): void => {
    try {
      void navigator.clipboard?.writeText(demoQrText).catch(() => undefined);
    } catch {
      // Clipboard access can be refused; the confirmation still shows.
    }
    setCopiedQr(true);
    setTimeout(() => setCopiedQr(false), 2000);
  };

  return (
    <div className="lp" dir="ltr" lang="en">
      {/* Background subtle mesh gradient */}
      <div className="lp-mesh" aria-hidden="true">
        <div className="lp-mesh__a" />
        <div className="lp-mesh__b" />
        <div className="lp-mesh__c" />
      </div>

      {/* Header / navigation */}
      <header className="lp-header">
        <div className="lp-container lp-header__bar">
          <a href="#" className="lp-logo">
            <span className="lp-logo__mark">
              <Logo />
            </span>
            <span className="lp-logo__text">
              <span className="lp-logo__name">
                1<span className="lp-logo__to">to</span>1<span className="lp-logo__os">OS</span>
              </span>
              <span className="lp-logo__tag">One Platform</span>
            </span>
          </a>

          <nav className="lp-nav" aria-label="Main">
            {NAV.map(([href, label]) => (
              <a key={href} href={href}>
                {label}
              </a>
            ))}
          </nav>

          <div className="lp-header__actions">
            <Link href={employeeLoginHref} className="lp-signin lp-signin--employee">
              <Users className="lp-i4" />
              Employee Sign In
            </Link>
            <Link href={loginHref} className="lp-signin">
              Sign In
            </Link>
            <a href="#pricing" className="lp-ghost-cta">
              <span className="lp-ghost-cta__ring" />
              <span className="lp-ghost-cta__inner">
                Start Free Tier
                <ArrowRight className="lp-i4" />
              </span>
            </a>
          </div>

          <button
            type="button"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="lp-burger"
            aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={mobileMenuOpen}
          >
            {mobileMenuOpen ? <X className="lp-i6" /> : <Menu className="lp-i6" />}
          </button>
        </div>

        {mobileMenuOpen && (
          <div className="lp-mobile-menu">
            {NAV.map(([href, label]) => (
              <a key={href} href={href} onClick={() => setMobileMenuOpen(false)}>
                {label}
              </a>
            ))}
            <div className="lp-mobile-menu__actions">
              <Link href={employeeLoginHref} className="lp-mobile-menu__signin">
                Employee Sign In
              </Link>
              <Link href={loginHref} className="lp-mobile-menu__signin">
                Sign In
              </Link>
              <a
                href="#pricing"
                onClick={() => setMobileMenuOpen(false)}
                className="lp-mobile-menu__cta"
              >
                Start Free Tier
              </a>
            </div>
          </div>
        )}
      </header>

      <main>
        {/* Hero */}
        <section className="lp-hero">
          <div className="lp-container lp-center">
            <div className="lp-badge">
              <Sparkles className="lp-i35" />
              <span>Introducing 1to1OS All-In-One System</span>
            </div>

            <h1 className="lp-hero__title">
              One Platform. <br />
              <span className="lp-gradient-text">Infinite Possibilities.</span>
            </h1>

            <p className="lp-hero__lead">
              Unify your enterprise ERP operations, personal financial goals, and dynamic QR
              marketing in one frictionless, cloud-native ecosystem.
            </p>

            <div className="lp-hero__ctas">
              <a href="#pricing" className="lp-btn lp-btn--primary">
                Start Free Trial
                <ArrowRight className="lp-i5" />
              </a>
              <a href="#products" className="lp-btn lp-btn--secondary">
                Explore Features
              </a>
            </div>
            <p className="lp-hero__employee">
              Are you an employee?{' '}
              <Link href={employeeLoginHref}>
                Sign in with the details your company gave you
                <ArrowRight className="lp-i4" />
              </Link>
            </p>

            {/* Interactive dashboard preview */}
            <div className="lp-window" id="preview">
              <div className="lp-window__bar">
                <div className="lp-window__dots">
                  <span className="lp-dot lp-dot--rose" />
                  <span className="lp-dot lp-dot--amber" />
                  <span className="lp-dot lp-dot--emerald" />
                  <span className="lp-window__url">app.1to1os.com/dashboard</span>
                </div>
                <div className="lp-segment lp-segment--sm" role="tablist">
                  {(
                    [
                      ['overview', 'ERP Workspace'],
                      ['finance', 'Personal Finance'],
                      ['qr', 'QR Studio'],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={activeDashboardTab === id}
                      onClick={() => setActiveDashboardTab(id)}
                      className={activeDashboardTab === id ? 'is-active' : undefined}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="lp-window__body">
                {activeDashboardTab === 'overview' && (
                  <div className="lp-stack lp-fade">
                    <div className="lp-grid-3">
                      <div className="lp-metric">
                        <div className="lp-metric__head">
                          <span>Total Revenue</span>
                          <TrendingUp className="lp-i4 lp-c-emerald" />
                        </div>
                        <div className="lp-metric__value">$48,290.00</div>
                        <span className="lp-metric__note lp-c-emerald">+14.2% from last month</span>
                      </div>
                      <div className="lp-metric">
                        <div className="lp-metric__head">
                          <span>Outstanding Invoices</span>
                          <Receipt className="lp-i4 lp-c-amber" />
                        </div>
                        <div className="lp-metric__value">$3,120.00</div>
                        <span className="lp-metric__note">4 Pending clients</span>
                      </div>
                      <div className="lp-metric">
                        <div className="lp-metric__head">
                          <span>Active CRM Leads</span>
                          <Users className="lp-i4 lp-c-accent" />
                        </div>
                        <div className="lp-metric__value">128</div>
                        <span className="lp-metric__note lp-c-emerald">8 new converted today</span>
                      </div>
                    </div>

                    <div className="lp-table">
                      <div className="lp-table__title">Recent ERP Invoices</div>
                      <div className="lp-table__rows">
                        <div className="lp-table__row">
                          <span className="lp-mono">#INV-2026-089</span>
                          <span className="lp-strong">TechCorp Ltd.</span>
                          <span className="lp-mono">$1,450.00</span>
                          <span className="lp-pill lp-pill--paid">Paid</span>
                        </div>
                        <div className="lp-table__row">
                          <span className="lp-mono">#INV-2026-090</span>
                          <span className="lp-strong">Acme Solutions</span>
                          <span className="lp-mono">$820.00</span>
                          <span className="lp-pill lp-pill--pending">Pending</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {activeDashboardTab === 'finance' && (
                  <div className="lp-stack lp-fade">
                    <div className="lp-grid-2">
                      <div className="lp-metric lp-metric--lg">
                        <div className="lp-metric__label">Personal Monthly Budget</div>
                        <div className="lp-metric__value lp-metric__value--xl lp-c-accent">
                          $6,500.00
                        </div>
                        <div className="lp-progress">
                          <div className="lp-progress__bar" />
                        </div>
                        <div className="lp-progress__legend">
                          <span>Spent: $4,030.00</span>
                          <span>Remaining: $2,470.00</span>
                        </div>
                      </div>
                      <div className="lp-metric lp-metric--lg lp-metric--split">
                        <div>
                          <div className="lp-metric__label">Savings Goal: New Car</div>
                          <div className="lp-metric__value">$18,400 / $25,000</div>
                        </div>
                        <div className="lp-callout">
                          <PieChart className="lp-i8 lp-c-accent" />
                          <span>You are on track to hit your savings target by December 2026!</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {activeDashboardTab === 'qr' && (
                  <div className="lp-qr-demo lp-fade">
                    <div className="lp-qr-demo__copy">
                      <div className="lp-qr-demo__title">Dynamic Brand QR Code Generator</div>
                      <p>
                        Generate high-resolution vector QRs with integrated analytics, custom logos,
                        and dynamic URL redirection.
                      </p>
                      <div className="lp-qr-demo__field">
                        <input
                          type="text"
                          aria-label="QR target URL"
                          value={demoQrText}
                          onChange={(e) => setDemoQrText(e.target.value)}
                        />
                        <button type="button" onClick={handleCopyLink}>
                          {copiedQr ? (
                            <CheckCircle2 className="lp-i35 lp-c-emerald" />
                          ) : (
                            <Copy className="lp-i35" />
                          )}
                          {copiedQr ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                    </div>
                    <div className="lp-qr">
                      <div className="lp-qr__frame">
                        <div className="lp-qr__grid">
                          {QR_CELLS.split('').map((c, i) => (
                            <div key={i} className={`lp-qr__cell ${QR_CLASS[c] ?? ''}`} />
                          ))}
                        </div>
                      </div>
                      <span className="lp-qr__caption">1to1os Dynamic QR</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* Core product pillars */}
        <section id="products" className="lp-section lp-section--band">
          <div className="lp-container">
            <div className="lp-section__head">
              <h2 className="lp-eyebrow">Core Pillars</h2>
              <p className="lp-section__title">Three Essential Suites. One Unified Dashboard.</p>
              <p className="lp-section__lead">
                Say goodbye to fragmented SaaS subscriptions. Manage business operations, personal
                wealth, and marketing workflows in single harmony.
              </p>
            </div>

            <div className="lp-cards-3">
              {PILLARS.map((p) => {
                const Icon = p.icon;
                return (
                  <div
                    key={p.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={activeTab === p.id}
                    onClick={() => setActiveTab(p.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setActiveTab(p.id);
                      }
                    }}
                    className={`lp-pillar ${activeTab === p.id ? 'is-active' : ''}`}
                  >
                    <div className={`lp-icon-tile lp-icon-tile--${p.tone}`}>
                      <Icon className="lp-i6" />
                    </div>
                    <h3 className="lp-pillar__title">{p.title}</h3>
                    <p className="lp-pillar__body">{p.body}</p>
                    <ul className="lp-ticks">
                      {p.points.map((pt) => (
                        <Tick key={pt}>{pt}</Tick>
                      ))}
                    </ul>
                    {p.id === 'erp' ? (
                      <Link
                        href={publicPath(locale, 'features')}
                        className="lp-pillar__cta"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {p.cta} <ChevronRight className="lp-i4" />
                      </Link>
                    ) : (
                      <button
                        type="button"
                        className="lp-pillar__cta"
                        onClick={(e) => {
                          e.stopPropagation();
                          showPreview(p.id);
                        }}
                      >
                        {p.cta} <ChevronRight className="lp-i4" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* Cloud & infrastructure architecture */}
        <section id="features" className="lp-section">
          <div className="lp-container lp-arch">
            <div>
              <div className="lp-chip">
                <Cpu className="lp-i35" /> High-Performance Infrastructure
              </div>
              <h2 className="lp-section__title lp-section__title--tight">
                Architected for Speed, Scalability & Ironclad Protection
              </h2>
              <p className="lp-section__lead">
                Your enterprise data deserves enterprise reliability. 1to1OS is engineered on a
                resilient edge infrastructure to provide 99.99% uptime and instant latency
                worldwide.
              </p>

              <div id="security" className="lp-features">
                <div className="lp-feature">
                  <div className="lp-feature__icon lp-icon-tile--accent">
                    <ShieldCheck className="lp-i5" />
                  </div>
                  <div>
                    <h4>Cloudflare Edge Shield</h4>
                    <p>
                      Enterprise DDoS protection, web application firewall (WAF), and global CDN
                      edge routing for lightning-fast speeds.
                    </p>
                  </div>
                </div>
                <div className="lp-feature">
                  <div className="lp-feature__icon lp-icon-tile--blue">
                    <Zap className="lp-i5" />
                  </div>
                  <div>
                    <h4>Railway Containerized Backend</h4>
                    <p>
                      Self-scaling microservices with dedicated PostgreSQL databases ensure zero
                      performance bottlenecks during peak loads.
                    </p>
                  </div>
                </div>
                <div className="lp-feature">
                  <div className="lp-feature__icon lp-icon-tile--emerald">
                    <Lock className="lp-i5" />
                  </div>
                  <div>
                    <h4>End-to-End Encryption</h4>
                    <p>
                      All financial records and business ledgers are encrypted at rest with AES-256
                      and transmitted securely over TLS 1.3.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="lp-blueprint">
              <div className="lp-blueprint__label">Architecture Blueprint</div>
              <div className="lp-stack-sm">
                <div className="lp-layer">
                  <div className="lp-layer__main">
                    <Globe className="lp-i5 lp-c-sky" />
                    <div>
                      <div className="lp-layer__title">Custom Domain & DNS</div>
                      <div className="lp-layer__sub">1to1os.com DNS Management</div>
                    </div>
                  </div>
                  <span className="lp-tag lp-tag--sky">Active</span>
                </div>
                <div className="lp-layer">
                  <div className="lp-layer__main">
                    <ShieldCheck className="lp-i5 lp-c-accent" />
                    <div>
                      <div className="lp-layer__title">Cloudflare Protection</div>
                      <div className="lp-layer__sub">DDoS Mitigation & SSL Engine</div>
                    </div>
                  </div>
                  <span className="lp-tag lp-tag--accent">Protected</span>
                </div>
                <div className="lp-layer">
                  <div className="lp-layer__main">
                    <Cpu className="lp-i5 lp-c-indigo" />
                    <div>
                      <div className="lp-layer__title">Railway Cloud Compute</div>
                      <div className="lp-layer__sub">Auto-scaling App Engine & DB</div>
                    </div>
                  </div>
                  <span className="lp-tag lp-tag--indigo">99.99% Uptime</span>
                </div>
              </div>
              <div className="lp-blueprint__foot">
                <span>
                  Global Response Time: <strong className="lp-mono lp-white">&lt;24ms</strong>
                </span>
                <span>
                  Database Sync: <strong className="lp-mono lp-c-emerald">Real-time</strong>
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="lp-section lp-section--pricing">
          <div className="lp-container">
            <div className="lp-section__head lp-section__head--pricing">
              <h2 className="lp-eyebrow">Transparent Pricing</h2>
              <p className="lp-section__title">Start Free. Upgrade As You Expand.</p>
              <p className="lp-section__lead">
                No hidden fees. Free tier available forever to help you get started with zero risk.
              </p>

              <div className="lp-segment lp-segment--billing">
                <button
                  type="button"
                  onClick={() => setIsAnnual(false)}
                  className={!isAnnual ? 'is-active' : undefined}
                  aria-pressed={!isAnnual}
                >
                  Monthly Billing
                </button>
                <button
                  type="button"
                  onClick={() => setIsAnnual(true)}
                  className={isAnnual ? 'is-active' : undefined}
                  aria-pressed={isAnnual}
                >
                  Annual Billing
                  <span className="lp-save">Save 20%</span>
                </button>
              </div>
            </div>

            <div className="lp-cards-3 lp-cards-3--stretch">
              {/* Free */}
              <div className="lp-plan">
                <div>
                  <div className="lp-plan__head">
                    <h3>Starter (Free)</h3>
                    <span className="lp-plan__badge">Free Forever</span>
                  </div>
                  <p className="lp-plan__desc">
                    Essential tools for freelancers, individuals, and simple setups.
                  </p>
                  <div className="lp-plan__price">
                    <span>$0</span>
                    <small>/ month</small>
                  </div>
                  <ul className="lp-ticks lp-ticks--plan">
                    <Tick>Basic Invoicing (up to 15/mo)</Tick>
                    <Tick>Personal Budget & Expense Logging</Tick>
                    <Tick>3 Static QR Code Generators</Tick>
                    <Tick>Single-user workspace</Tick>
                  </ul>
                </div>
                <Link href={registerHref} className="lp-plan__btn">
                  Get Started Free
                </Link>
              </div>

              {/* Pro (featured) */}
              <div className="lp-plan lp-plan--featured">
                <div className="lp-plan__ribbon">Most Popular</div>
                <div>
                  <div className="lp-plan__head">
                    <h3>Pro Growth</h3>
                    <span className="lp-plan__badge lp-plan__badge--accent">Complete OS</span>
                  </div>
                  <p className="lp-plan__desc">
                    Designed for growing businesses requiring full ERP & analytics capability.
                  </p>
                  <div className="lp-plan__price">
                    <span>{isAnnual ? '$29' : '$36'}</span>
                    <small>/ month</small>
                  </div>
                  <ul className="lp-ticks lp-ticks--plan">
                    <Tick>Unlimited ERP Invoices & CRM Contacts</Tick>
                    <Tick>Advanced Multi-Currency Accounting</Tick>
                    <Tick>Dynamic QR Studio with Scan Analytics</Tick>
                    <Tick>Up to 5 Team Members</Tick>
                    <Tick>Automated Recurring Billing</Tick>
                  </ul>
                </div>
                <Link href={registerHref} className="lp-plan__btn lp-plan__btn--primary">
                  Start 14-Day Free Trial
                </Link>
              </div>

              {/* Enterprise */}
              <div className="lp-plan">
                <div>
                  <div className="lp-plan__head">
                    <h3>Enterprise</h3>
                    <span className="lp-plan__badge">Custom</span>
                  </div>
                  <p className="lp-plan__desc">
                    For scale-ups needing custom workflows, dedicated API access, and SLAs.
                  </p>
                  <div className="lp-plan__price">
                    <span>{isAnnual ? '$89' : '$109'}</span>
                    <small>/ month</small>
                  </div>
                  <ul className="lp-ticks lp-ticks--plan">
                    <Tick>Unlimited Team Seats & Roles</Tick>
                    <Tick>Dedicated API & Webhook Integrations</Tick>
                    <Tick>Custom Branding on QR & Invoices</Tick>
                    <Tick>24/7 Priority Support & Dedicated Manager</Tick>
                  </ul>
                </div>
                <Link href={contactHref} className="lp-plan__btn">
                  Contact Enterprise Sales
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="lp-footer">
        <div className="lp-container">
          <div className="lp-footer__grid">
            <div className="lp-footer__brand">
              <div className="lp-footer__logo">
                <span className="lp-footer__mark">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    aria-hidden="true"
                  >
                    <path d="M4 12h16" />
                    <path d="M7 6v12" />
                    <path d="M17 6v12" />
                  </svg>
                </span>
                <span>1to1os.com</span>
              </div>
              <p>
                The all-in-one OS for business ERP management, personal wealth tracking, and dynamic
                QR tools.
              </p>
            </div>

            <div>
              <h4 className="lp-footer__heading">Products</h4>
              <ul className="lp-footer__links">
                <li>
                  <a href="#products">One to One ERP</a>
                </li>
                <li>
                  <a href="#products">Personal Wealth OS</a>
                </li>
                <li>
                  <a href="#products">Dynamic QR Studio</a>
                </li>
                <li>
                  <a href="#pricing">Free Tier Plan</a>
                </li>
              </ul>
            </div>

            <div>
              <h4 className="lp-footer__heading">Infrastructure</h4>
              <ul className="lp-footer__links">
                <li>
                  <a href="#features">Cloudflare Edge Shield</a>
                </li>
                <li>
                  <a href="#features">Railway Cloud Hosting</a>
                </li>
                <li>
                  <a href="#security">Security & Encryption</a>
                </li>
                <li>
                  <span className="lp-mono lp-dim">Domain: 1to1os.com</span>
                </li>
              </ul>
            </div>

            <div>
              <h4 className="lp-footer__heading">Stay Connected</h4>
              <p className="lp-footer__note">Subscribe for updates on new feature releases.</p>
              <form className="lp-footer__form" onSubmit={(e) => e.preventDefault()}>
                <input type="email" placeholder="Enter email address" aria-label="Email address" />
                <button type="submit">Join</button>
              </form>
            </div>
          </div>

          <div className="lp-footer__bottom">
            <div>© {new Date().getFullYear()} 1to1os.com. All rights reserved.</div>
            <div className="lp-footer__legal">
              <a href="#">Privacy Policy</a>
              <a href="#">Terms of Service</a>
              <a href="#">Security Whitepaper</a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
