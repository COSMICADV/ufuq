/* Phase 16 verification against the explicit loopback-only preview fixture.
 * PLAYWRIGHT_MODULE and AXE_MODULE can point to temporary tooling installations.
 * Start the production web build and the PHASE16_PREVIEW test fixture first.
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const AxeBuilder = require(process.env.AXE_MODULE || '@axe-core/playwright').default;
const fs = require('node:fs');
const assert = require('node:assert/strict');
const run = Date.now().toString(36);
const paths = [
  '',
  'about',
  'features',
  'for-companies',
  'for-individuals',
  'pricing',
  'contact',
  'login',
  'register',
];
const widths = [375, 800, 1280, 360, 390, 430, 768, 1024, 1440, 1920];
const base = 'http://localhost:3000';
const url = (locale, path) => `${base}${locale === 'en' ? '/en' : ''}${path ? '/' + path : ''}`;
const result = process.env.PHASE16_PERF_ONLY
  ? {
      ...JSON.parse(fs.readFileSync('/private/tmp/ufuq-phase16-browser-results.json', 'utf8')),
      performance: [],
      screenshots: [],
      error: undefined,
    }
  : process.env.SKIP_MATRIX
    ? {
        ...JSON.parse(fs.readFileSync('/private/tmp/ufuq-phase16-browser-results.json', 'utf8')),
        forms: [],
        performance: [],
        screenshots: [],
        error: undefined,
      }
    : {
        pages: 0,
        responsiveChecks: 0,
        axeScans: 0,
        axeViolations: [],
        links: 0,
        forms: [],
        performance: [],
        screenshots: [],
      };
(async () => {
  let browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  result.browser = browser.version();
  browser.on('disconnected', () => console.log('Browser disconnected'));
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const links = new Set();
  if (!process.env.SKIP_MATRIX && !process.env.PHASE16_PERF_ONLY) {
    for (const locale of ['ar', 'en'])
      for (const path of paths) {
        const response = await page.goto(url(locale, path), { waitUntil: 'networkidle' });
        assert.equal(response.status(), 200, locale + '/' + path);
        assert.equal(await page.locator('html').getAttribute('lang'), locale);
        assert.equal(
          await page.locator('html').getAttribute('dir'),
          locale === 'ar' ? 'rtl' : 'ltr',
        );
        assert.equal(await page.locator('h1').count(), 1);
        assert.ok((await page.title()).length > 5);
        assert.ok(await page.locator('meta[name="description"]').getAttribute('content'));
        assert.equal(
          await page.locator('link[rel="canonical"]').getAttribute('href'),
          url(locale, path) || base,
        );
        for (const l of ['ar', 'en', 'x-default'])
          assert.equal(await page.locator(`link[hreflang="${l}"]`).count(), 1);
        if (path === '')
          assert.equal(
            JSON.parse(await page.locator('script[type="application/ld+json"]').textContent())[
              '@type'
            ],
            'WebSite',
          );
        for (const href of await page
          .locator('a[href]')
          .evaluateAll((els) => els.map((e) => e.getAttribute('href'))))
          if (href.startsWith('/')) links.add(href);
        for (const width of widths) {
          await page.setViewportSize({ width, height: 900 });
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
            `Overflow ${locale}/${path} ${width}`,
          );
          if (width === 375 || width === 800)
            assert.deepEqual(
              await page.locator('a,button,summary').evaluateAll((els) =>
                els
                  .filter(
                    (e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden',
                  )
                  .filter((e) => {
                    const r = e.getBoundingClientRect();
                    return r.width < 44 || r.height < 44;
                  })
                  .map((e) => ({ tag: e.tagName, text: e.textContent })),
              ),
              [],
              `Small touch target ${locale}/${path} ${width}`,
            );
          result.responsiveChecks++;
          if ([375, 800, 1280].includes(width)) {
            const scan = await new AxeBuilder({ page })
              .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
              .analyze();
            result.axeScans++;
            if (scan.violations.length)
              result.axeViolations.push({
                locale,
                path,
                width,
                violations: scan.violations.map((v) => ({
                  id: v.id,
                  nodes: v.nodes.map((n) => n.target),
                })),
              });
          }
        }
        result.pages++;
      }
    for (const href of links) {
      assert.equal((await context.request.get(base + href)).status(), 200, 'Dead link ' + href);
      result.links++;
    }
    assert.equal(errors.length, 0, errors.join('\n'));
    // Keyboard access to the skip link and native mobile disclosure.
    await page.setViewportSize({ width: 375, height: 844 });
    await page.goto(base);
    await page.keyboard.press('Tab');
    assert.equal(await page.locator(':focus').getAttribute('href'), '#content');
    await page.keyboard.press('Enter');
    await page.locator('.public-mobile-nav summary').click();
    assert.equal(await page.locator('.public-mobile-nav').getAttribute('open'), '');
    await page.locator('.public-mobile-nav a[href="/features"]').click();
    await page.waitForURL('**/features');
    await page.locator('.public-account a[lang="en"]').click();
    await page.waitForURL('**/en/features');
    assert.equal(await page.locator('html').getAttribute('dir'), 'ltr');
    // Conversion chains are followed using visible links.
    await page.goto(base);
    await page.locator('.public-actions a[href="/features"]').click();
    await page.waitForURL('**/features');
    await page.locator('.public-desktop-nav').evaluate((e) => (e.style.display = 'flex'));
    await page.locator('footer a[href="/for-companies"]').click();
    await page.waitForURL('**/for-companies');
    await page.locator('.public-final a').click();
    await page.waitForURL('**/register');
    await page.goto(base);
    await page.locator('footer a[href="/pricing"]').click();
    await page.waitForURL('**/pricing');
    await page.locator('main a[href="/contact"]').click();
    await page.waitForURL('**/contact');
    // Readable server output without JavaScript in both languages, all nine pages.
    const noJS = await browser.newContext({ javaScriptEnabled: false });
    const plain = await noJS.newPage();
    for (const locale of ['ar', 'en'])
      for (const path of paths) {
        await plain.goto(url(locale, path));
        assert.ok((await plain.locator('h1').innerText()).length > 5);
        assert.equal(await plain.locator('footer a').count(), 10);
      }
    await noJS.close();
  }
  await context.close();
  // Actual form submits against the disposable API and fake mail transport.
  if (!process.env.PHASE16_PERF_ONLY) {
    for (const locale of ['ar', 'en']) {
      const formContext = await browser.newContext({ viewport: { width: 375, height: 844 } });
      const form = await formContext.newPage();
      await form.goto(url(locale, 'contact'));
      await form.locator('[name="name"]').fill(locale === 'ar' ? 'سارة اختبار' : 'Sara Test');
      await form.locator('[name="company"]').fill('Local Browser Company');
      await form.locator('[name="email"]').fill(`browser-contact-${locale}-${run}@ufuq.test`);
      await form.locator('[name="phone"]').fill('+201000000000');
      await form.locator('[name="message"]').fill('طلب معرفة الأسعار — A local test enquiry.');
      await form.locator('[name="email"]').fill('invalid-email');
      await form.locator('button[type="submit"]').click();
      assert.equal(await form.locator('[name="email"]').evaluate((e) => e.validity.valid), false);
      await form.locator('[name="email"]').fill(`browser-contact-${locale}-${run}@ufuq.test`);
      await form.waitForTimeout(1600);
      // Error + preserved input + retry (safe UI response simulation; real transport failure tested in e2e).
      await form.route(
        '**/api/v1/public/contact',
        (route) =>
          route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: { code: 'MAIL_DELIVERY_FAILED' } }),
          }),
        { times: 1 },
      );
      await form.locator('button[type="submit"]').click();
      await form.locator('form [role="alert"]').waitFor();
      assert.equal(await form.locator('[name="company"]').inputValue(), 'Local Browser Company');
      await form.route(
        '**/api/v1/public/contact',
        async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 500));
          await route.continue();
        },
        { times: 1 },
      );
      const sending = form.locator('button[type="submit"]').click();
      await form.locator('fieldset[disabled]').waitFor();
      await sending;
      await form.locator('[role="status"]').first().waitFor();
      assert.ok(
        JSON.parse(fs.readFileSync('/private/tmp/ufuq-phase16-mail.json', 'utf8')).some(
          (m) => m.replyTo === `browser-contact-${locale}-${run}@ufuq.test`,
        ),
      );
      result.forms.push(locale + ' actual contact + safe error/retry');
      await form.goto(url(locale, 'register'));
      const email = `browser-register-${locale}-${run}@ufuq.test`;
      await form
        .locator('[name="admin_name"]')
        .fill(locale === 'ar' ? 'مسؤول اختبار' : 'Test Administrator');
      await form.locator('[name="company_name"]').fill('Local Browser ' + locale);
      await form.locator('[name="email"]').fill(email);
      await form.locator('[name="phone"]').fill('+201000000001');
      await form.locator('[name="employee_count_range"]').selectOption('11-50');
      await form.locator('[name="password"]').fill('a-safe-registration-passphrase');
      await form.waitForTimeout(1600);
      await form.locator('button[type="submit"]').click();
      await form.locator('[role="status"]').first().waitFor();
      const messages = JSON.parse(fs.readFileSync('/private/tmp/ufuq-phase16-mail.json', 'utf8'));
      const message = messages.find((m) => m.to === email);
      assert.ok(message);
      const activation = message.text.match(/https?:[^\s]+#token=[^\s]+/)[0];
      await form.goto(activation);
      await form.locator('input[type="password"]').first().fill('a-safe-registration-passphrase');
      await form.locator('input[type="password"]').nth(1).fill('a-safe-registration-passphrase');
      await form.locator('input[type="checkbox"]').check();
      await form.locator('button[type="submit"]').click();
      await form.locator('[role="status"]').first().waitFor();
      await form.locator(`[href="${locale === 'ar' ? '/login' : '/en/login'}"]`).click();
      await form.locator('[name="email"]').fill(email);
      await form.locator('[name="password"]').fill('a-safe-registration-passphrase');
      await form.locator('button[type="submit"]').click();
      await form.waitForURL(`**/${locale}/admin/settings/company`);
      await form.waitForFunction(
        (expected) =>
          Array.from(document.querySelectorAll('input')).some((input) => input.value === expected),
        'Local Browser ' + locale,
      );
      result.forms.push(
        locale + ' actual registration → email activation → login → company settings',
      );
      await formContext.close();
    }
  }
  // Start a fresh browser for performance after the heavier axe/form matrix.
  await browser.close();
  browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  // Actual browser LCP/CLS under a documented local 4G profile, four-times CPU slowdown.
  for (const locale of ['ar', 'en'])
    for (const path of ['', 'features']) {
      const perfContext = await browser.newContext({ viewport: { width: 375, height: 844 } });
      const perf = await perfContext.newPage();
      const cdp = await perfContext.newCDPSession(perf);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 150,
        downloadThroughput: (1.6 * 1024 * 1024) / 8,
        uploadThroughput: (750 * 1024) / 8,
      });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await perf.addInitScript(() => {
        window.__metrics = { lcp: 0, cls: 0 };
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) window.__metrics.lcp = e.startTime;
        }).observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) if (!e.hadRecentInput) window.__metrics.cls += e.value;
        }).observe({ type: 'layout-shift', buffered: true });
      });
      await perf.goto(url(locale, path), { waitUntil: 'networkidle' });
      await perf.waitForTimeout(1000);
      result.performance.push({
        locale,
        path: path || 'home',
        ...(await perf.evaluate(() => window.__metrics)),
      });
      await perfContext.close();
    }
  const screenshotContext = await browser.newContext();
  const screenshotPage = await screenshotContext.newPage();
  await screenshotPage.setViewportSize({ width: 1280, height: 900 });
  for (const locale of ['ar', 'en']) {
    await screenshotPage.goto(url(locale, ''));
    const out = `/private/tmp/ufuq-phase16-home-${locale}.png`;
    await screenshotPage.screenshot({ path: out, fullPage: true });
    result.screenshots.push(out);
  }
  await browser.close();
  fs.writeFileSync(
    '/private/tmp/ufuq-phase16-browser-results.json',
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.axeViolations.length, 0, 'Accessibility violations');
})().catch((e) => {
  fs.writeFileSync(
    '/private/tmp/ufuq-phase16-browser-results.json',
    JSON.stringify({ ...result, error: e.message }, null, 2),
  );
  console.error(e);
  process.exit(1);
});
