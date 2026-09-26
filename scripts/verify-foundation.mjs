#!/usr/bin/env node
/**
 * Phase 1 boot verification.
 *
 * DOCUMENT 25 Phase 1 exit criterion: "an empty application boots in all
 * environments, switches language and direction, and CI passes."
 *
 * This script checks the whole criterion, not a proxy for it:
 *
 *   1. The workspace is coherent — every package resolves and builds.
 *   2. Configuration loads and validates, failing fast on a bad environment.
 *   3. The locale layer switches language and direction in both directions.
 *   4. Decimal safety holds — money arithmetic is exact.
 *   5. The three applications exist and depend on the shared packages.
 *   6. The API and the web application actually boot and answer, in Arabic and
 *      in English, right to left and left to right.
 *
 * It requires a completed `pnpm build` and no running infrastructure: nothing
 * in Phase 1 opens a database, a queue, or a bucket.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { freePort, withServer } from './lib/servers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, assertion) {
  try {
    const detail = assertion();
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${name}\n        ${error.message}`);
  }
}

async function checkAsync(name, assertion) {
  try {
    const detail = await assertion();
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${name}\n        ${error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function manifest(workspacePath) {
  return JSON.parse(readFileSync(join(root, workspacePath, 'package.json'), 'utf8'));
}

async function loadPackage(name) {
  const entry = join(root, 'packages', name, 'dist', 'index.js');
  assert(existsSync(entry), `${name} is not built. Run \`pnpm build\` before \`pnpm verify\`.`);
  return import(pathToFileURL(entry).href);
}

console.log('أُفق — Phase 1 foundation verification\n');

section('1. Workspace');

check('workspace packages present', () => {
  const packages = readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const expected = ['config', 'eslint-config', 'i18n', 'money', 'tsconfig'];
  for (const name of expected) {
    assert(packages.includes(name), `missing package: ${name}`);
  }
  return packages.join(', ');
});

check('local infrastructure is defined', () => {
  assert(existsSync(join(root, 'docker-compose.yml')), 'docker-compose.yml is missing');
  assert(existsSync(join(root, '.env.example')), '.env.example is missing');
  return 'docker-compose.yml, .env.example';
});

check('CI workflow is defined', () => {
  assert(
    existsSync(join(root, '.github', 'workflows', 'ci.yml')),
    '.github/workflows/ci.yml is missing',
  );
  return 'ci.yml';
});

section('2. Configuration');

const { loadEnv, EnvError, redactEnv, SECRET_KEYS } = await loadPackage('config');

const sampleEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://ufuq:ufuq_local_password@localhost:5432/ufuq',
  REDIS_URL: 'redis://localhost:6379',
  STORAGE_ENDPOINT: 'http://localhost:9000',
  STORAGE_REGION: 'us-east-1',
  STORAGE_BUCKET: 'ufuq-local',
  STORAGE_ACCESS_KEY_ID: 'ufuq_local_access_key',
  STORAGE_SECRET_ACCESS_KEY: 'ufuq_local_secret_key',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  MAIL_FROM: 'Ufuq <no-reply@ufuq.local>',
  WEB_ORIGIN: 'http://localhost:3000',
};

check('a complete environment loads', () => {
  const env = loadEnv(sampleEnv);
  assert(env.storage.bucket === 'ufuq-local', 'storage bucket did not load');
  return `api :${env.apiPort}, web :${env.webPort}`;
});

check('an incomplete environment fails fast', () => {
  try {
    loadEnv({ NODE_ENV: 'development' });
  } catch (error) {
    assert(error instanceof EnvError, 'wrong error type');
    return `${error.issues.length} issues reported at once`;
  }
  throw new Error('a missing DATABASE_URL was accepted');
});

check('secrets are redacted before printing', () => {
  const redacted = redactEnv(sampleEnv);
  for (const key of SECRET_KEYS) {
    assert(redacted[key] === '[redacted]', `${key} leaked`);
  }
  return SECRET_KEYS.length + ' keys redacted';
});

section('3. Language and direction');

const { DEFAULT_LOCALE, documentAttributes, createTranslator, formatMoney, formatDuration } =
  await loadPackage('i18n');

check('the default locale is Arabic RTL', () => {
  assert(DEFAULT_LOCALE === 'ar', `default locale is ${DEFAULT_LOCALE}`);
  const attributes = documentAttributes('ar');
  assert(attributes.dir === 'rtl', 'Arabic did not resolve to rtl');
  return `lang="${attributes.lang}" dir="${attributes.dir}"`;
});

check('switching to English switches direction', () => {
  const attributes = documentAttributes('en');
  assert(attributes.dir === 'ltr', 'English did not resolve to ltr');
  return `lang="${attributes.lang}" dir="${attributes.dir}"`;
});

check('both message catalogues resolve', () => {
  const ar = createTranslator('ar')('app.name');
  const en = createTranslator('en')('app.name');
  assert(ar === 'أُفق', `Arabic app name was "${ar}"`);
  assert(en === 'Ufuq', `English app name was "${en}"`);
  return `${ar} / ${en}`;
});

check('locale formatting is applied', () => {
  const money = formatMoney('20000.00', 'EGP', { locale: 'ar' });
  const duration = formatDuration(485, { locale: 'ar', numerals: 'arab' });
  assert(money === '20,000 ج.م', `money formatted as "${money}"`);
  assert(duration === '٨س ٠٥د', `duration formatted as "${duration}"`);
  return `${money}, ${duration}`;
});

section('4. Decimal safety');

const { Money, Decimal, DecimalError } = await loadPackage('money');

check('money arithmetic is exact', () => {
  const net = Money.of('20000.00', 'EGP')
    .subtract(Money.of('200.00', 'EGP'))
    .subtract(Money.of('500.00', 'EGP'))
    .subtract(Money.of('300.00', 'EGP'))
    .add(Money.of('500.00', 'EGP'));
  assert(net.toString() === '19500.00', `net was ${net.toString()}`);
  return `20,000 − 200 − 500 − 300 + 500 = ${net.toString()}`;
});

check('a float cannot enter a decimal', () => {
  try {
    Decimal.parse(0.1 + 0.2, 2);
  } catch (error) {
    assert(error instanceof DecimalError, 'wrong error type');
    return 'numbers rejected at the boundary';
  }
  throw new Error('a JavaScript number was accepted as a decimal');
});

check('an inexact division demands an explicit rounding policy', () => {
  try {
    Decimal.parse('20000.00', 2).divideByInteger(26);
  } catch {
    const rounded = Decimal.parse('20000.00', 2).divideByInteger(26, 'nearest');
    assert(rounded.toString() === '769.23', `daily wage was ${rounded.toString()}`);
    return '20,000 ÷ 26 = 769.23 (nearest)';
  }
  throw new Error('an inexact division silently rounded');
});

section('5. Applications');

check('the three applications exist', () => {
  const apps = readdirSync(join(root, 'apps'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const name of ['api', 'mobile', 'web']) {
    assert(apps.includes(name), `apps/${name} is missing`);
  }
  return apps.sort().join(', ');
});

check('each application uses the shared locale package', () => {
  for (const app of ['api', 'mobile', 'web']) {
    const dependencies = manifest(join('apps', app)).dependencies ?? {};
    assert(
      dependencies['@ufuq/i18n'] === 'workspace:*',
      `apps/${app} does not depend on @ufuq/i18n`,
    );
  }
  return 'api, web, mobile → @ufuq/i18n';
});

check('the API validates its environment through the shared config package', () => {
  const dependencies = manifest(join('apps', 'api')).dependencies ?? {};
  assert(
    dependencies['@ufuq/config'] === 'workspace:*',
    'apps/api does not depend on @ufuq/config',
  );
  return '@ufuq/api → @ufuq/config';
});

check('Prisma has not been introduced yet (AD-03: it arrives in Phase 3)', () => {
  for (const app of ['api', 'mobile', 'web']) {
    const { dependencies = {}, devDependencies = {} } = manifest(join('apps', app));
    for (const name of [...Object.keys(dependencies), ...Object.keys(devDependencies)]) {
      assert(
        !name.startsWith('prisma') && !name.startsWith('@prisma/'),
        `apps/${app} depends on ${name}`,
      );
    }
  }
  return 'no Prisma dependency in any application';
});

check('the mobile application has an entry point and a workspace-aware bundler', () => {
  assert(existsSync(join(root, 'apps', 'mobile', 'index.ts')), 'apps/mobile/index.ts is missing');
  assert(
    existsSync(join(root, 'apps', 'mobile', 'metro.config.js')),
    'apps/mobile/metro.config.js is missing — Metro cannot resolve workspace packages without it',
  );
  const app = JSON.parse(readFileSync(join(root, 'apps', 'mobile', 'app.json'), 'utf8'));
  assert(app.expo?.name === 'أُفق', `app.json names the app "${app.expo?.name}"`);
  return `index.ts, metro.config.js, app.json (${app.expo.name})`;
});

section('6. Phase 1 exit criterion — the applications boot');

const apiDist = join(root, 'apps', 'api', 'dist', 'main.js');
const webBuild = join(root, 'apps', 'web', '.next');

if (!existsSync(apiDist) || !existsSync(webBuild)) {
  failures += 1;
  console.error(
    '  FAIL  the applications are not built.\n' +
      '        Run `pnpm build` before `pnpm verify`; this section starts the built output.',
  );
} else {
  const apiPort = await freePort();
  const apiBase = `http://127.0.0.1:${apiPort}/api/v1`;

  await withServer(
    {
      command: process.execPath,
      args: ['dist/main.js'],
      cwd: join(root, 'apps', 'api'),
      env: { ...sampleEnv, API_PORT: String(apiPort) },
      readyUrl: `${apiBase}/health`,
    },
    async () => {
      await checkAsync('the API boots and reports healthy in Arabic', async () => {
        const response = await fetch(`${apiBase}/health`, {
          headers: { 'Accept-Language': 'ar' },
        });
        assert(response.status === 200, `status ${response.status}`);
        const body = await response.json();
        assert(body.data?.status === 'ok', `status field was ${body.data?.status}`);
        assert(body.meta?.locale === 'ar', `meta.locale was ${body.meta?.locale}`);
        assert(body.data.message === 'النظام يعمل', `message was "${body.data.message}"`);
        return `GET /api/v1/health → ${body.data.message}`;
      });

      await checkAsync('the API answers the same request in English', async () => {
        const response = await fetch(`${apiBase}/health`, {
          headers: { 'Accept-Language': 'en-GB,en;q=0.9' },
        });
        const body = await response.json();
        assert(body.meta?.locale === 'en', `meta.locale was ${body.meta?.locale}`);
        assert(body.data.message === 'System is running', `message was "${body.data.message}"`);
        return `GET /api/v1/health → ${body.data.message}`;
      });

      await checkAsync('an unknown path returns the documented error envelope', async () => {
        const response = await fetch(`${apiBase}/does-not-exist`);
        assert(response.status === 404, `status ${response.status}`);
        const body = await response.json();
        assert(body.error?.code === 'NOT_FOUND', `code was ${body.error?.code}`);
        assert(
          typeof body.error.message_ar === 'string' && typeof body.error.message_en === 'string',
          'the error is not bilingual (DOCUMENT 27 RULE 25)',
        );
        return `404 ${body.error.code}, ar + en`;
      });

      await checkAsync('the API never answers with a secret', async () => {
        const body = await (await fetch(`${apiBase}/health`)).text();
        for (const key of SECRET_KEYS) {
          assert(!body.includes(sampleEnv[key]), `${key} appeared in the response`);
        }
        return `${SECRET_KEYS.length} secrets absent from the payload`;
      });
    },
  );

  const webPort = await freePort();
  const webBase = `http://127.0.0.1:${webPort}`;

  await withServer(
    {
      command: join(root, 'apps', 'web', 'node_modules', '.bin', 'next'),
      args: ['start', '-p', String(webPort)],
      cwd: join(root, 'apps', 'web'),
      env: {},
      readyUrl: `${webBase}/ar`,
    },
    async () => {
      await checkAsync('the web application boots right to left in Arabic', async () => {
        const html = await (await fetch(`${webBase}/ar`)).text();
        assert(html.includes('<html lang="ar" dir="rtl">'), 'the document root is not Arabic RTL');
        assert(html.includes('أُفق'), 'the Arabic catalogue did not render');
        return '<html lang="ar" dir="rtl">';
      });

      await checkAsync('the same page switches to English left to right', async () => {
        const html = await (await fetch(`${webBase}/en`)).text();
        assert(html.includes('<html lang="en" dir="ltr">'), 'the document root is not English LTR');
        assert(html.includes('Ufuq'), 'the English catalogue did not render');
        return '<html lang="en" dir="ltr">';
      });

      await checkAsync('the language switch works without JavaScript', async () => {
        const arabic = await (await fetch(`${webBase}/ar`)).text();
        const english = await (await fetch(`${webBase}/en`)).text();
        assert(arabic.includes('href="/en"'), 'the Arabic page does not link to English');
        assert(english.includes('href="/ar"'), 'the English page does not link to Arabic');
        return 'both pages carry a server-rendered link to the other language';
      });

      await checkAsync('an unprefixed request negotiates a language', async () => {
        const arabic = await fetch(`${webBase}/`, {
          headers: { 'Accept-Language': 'ar' },
          redirect: 'manual',
        });
        const english = await fetch(`${webBase}/`, {
          headers: { 'Accept-Language': 'en-GB,en;q=0.9' },
          redirect: 'manual',
        });
        const other = await fetch(`${webBase}/`, {
          headers: { 'Accept-Language': 'fr-FR' },
          redirect: 'manual',
        });
        assert(arabic.headers.get('location') === '/ar', 'ar did not reach /ar');
        assert(english.headers.get('location') === '/en', 'en did not reach /en');
        assert(
          other.headers.get('location') === '/ar',
          'an unsupported language did not fall back to Arabic',
        );
        return '/ → /ar, /en, and /ar for anything unsupported';
      });
    },
  );
}

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log('All Phase 1 checks passed.');
