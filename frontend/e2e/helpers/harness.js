/**
 * End-to-end test harness.
 *
 * - serves the production build (`vite preview`)
 * - drives it with Playwright (real Chromium)
 * - replaces Google's APIs with the in-memory FakeSheets used by the unit tests, so the whole
 *   UI -> service -> "Google Sheets" path runs for real, with no network and no credentials.
 *
 * Usage:  const app = await startApp();  const { page, fake } = await app.open(tabs);  ...  await app.close();
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import { FakeSheets } from '../../src/tests/helpers/fakeSheets.js';

export { FakeSheets };

const freePort = () => new Promise((resolve, reject) => {
  const srv = createServer();
  srv.listen(0, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  srv.on('error', reject);
});

async function waitFor(url, timeoutMs = 30000) {
  const start = Date.now();
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* not up yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };

/** Route Google's Sheets API for a browser context to a FakeSheets instance. */
export async function mockGoogle(context, fake, { onRequest } = {}) {
  await context.route('https://accounts.google.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  await context.route('https://sheets.googleapis.com/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const u = new URL(req.url());
    const path = decodeURIComponent(u.pathname.replace('/v4/spreadsheets', '')) + u.search;
    onRequest?.(req.method(), path);
    try {
      const body = req.postData() ? JSON.parse(req.postData()) : undefined;
      const res = await fake[req.method().toLowerCase()](path, body);
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(res.data) });
    } catch (e) {
      return route.fulfill({
        status: e.response?.status || 500,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify(e.response?.data || { error: { message: e.message } }),
      });
    }
  });
}

export async function startApp({ headless = true } = {}) {
  const port = await freePort();
  const server = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { stdio: 'ignore' });
  const base = `http://localhost:${port}/`;
  await waitFor(base);
  const browser = await chromium.launch({ headless, executablePath: process.env.PW_CHROMIUM_PATH || undefined });

  return {
    base,
    browser,
    /** Open the app signed in, pointed at a fake spreadsheet built from `tabs`. */
    async open(tabs, { fake = new FakeSheets(tabs), signedIn = true, viewport = { width: 1400, height: 900 }, onRequest, timezoneId, locale } = {}) {
      const context = await browser.newContext({ viewport, timezoneId, locale });
      if (signedIn) {
        await context.addInitScript(() => {
          localStorage.setItem('google_access_token', 'fake-token');
          localStorage.setItem('google_token_expiry', String(Date.now() + 3600e3));
          localStorage.setItem('gsheets_spreadsheet_id', 'test-sheet');
        });
      }
      await mockGoogle(context, fake, { onRequest });
      const page = await context.newPage();
      const problems = [];
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`); });
      return {
        page, fake, context, problems,
        go: (hash) => page.goto(`${base}#${hash}`),
        toasts: () => page.locator('[aria-live=polite] [role]').allTextContents(),
        /** Wait until a toast matching `re` appears and return its text. */
        async toast(re, timeout = 8000) {
          const loc = page.locator('[aria-live=polite] [role]').filter({ hasText: re }).first();
          await loc.waitFor({ timeout });
          return loc.textContent();
        },
      };
    },
    async close() {
      await browser.close();
      server.kill();
    },
  };
}
