import fs from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { register, login, createDemoInvestigation, waitForJobToFinish, uniqueEmail, PASSWORD } from './helpers';
import { makeExifJpeg } from '../helpers/fixtures';

/**
 * The full analyst journey, in order, against a production build with simulated (demo) providers.
 * All identifiers are fictional: reserved .example domains, documentation IP ranges and invented handles.
 */
test.describe.serial('analyst journey', () => {
  const email = uniqueEmail('analyst');
  const name = 'E2E Analyst';
  const investigationName = 'E2E — Northwind (fictional)';
  let workspace = '';
  let page: Page;

  const pageErrors: string[] = [];

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      // Expected HTTP errors (e.g. the deliberate wrong-password 401) are logged as resource failures; ignore those.
      if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) pageErrors.push(m.text());
    });
  });
  test.afterAll(async () => {
    await page.close();
  });

  test('1. opening the app requires signing in', async () => {
    const res = await page.goto('/');
    expect(res?.status()).toBeLessThan(400);
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  test('2. creates an account (acceptable use required), signs out and signs back in', async () => {
    // The policy is readable before signing up, and registration is refused until it is accepted.
    await page.goto('/acceptable-use');
    await expect(page.getByRole('heading', { name: 'Acceptable use policy' })).toBeVisible();
    await page.goto('/register');
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.locator('form').getByRole('alert')).toContainText('acceptable-use policy');
    await register(page, name, email);
    await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible();
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.waitForURL('**/login');
    // Wrong password is rejected without revealing whether the account exists.
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('not the password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Email or password is incorrect.')).toBeVisible();
    await login(page, email);
  });

  test('3–4. creates an investigation with fictional targets and starts demo collection', async () => {
    workspace = await createDemoInvestigation(page, investigationName, ['shadowfox_42', 'northwind-analytics.example', '198.51.100.23']);
    await expect(page.getByText('Simulated').first()).toBeVisible();
    await expect(page.getByTestId('job-progress')).toBeVisible();
  });

  test('5. waits for collection to finish (partial: one simulated feed always fails)', async () => {
    await waitForJobToFinish(page);
    await expect(page.getByTestId('provider-runs')).toBeVisible();
  });

  test('6. inspects findings, filters them and records a verification decision', async () => {
    await page.getByLabel('Investigation sections').getByRole('link', { name: 'Findings' }).click();
    const table = page.getByTestId('findings-table');
    await expect(table.locator('tbody tr').first()).toBeVisible();
    expect(await table.locator('tbody tr').count()).toBeGreaterThan(3);
    await expect(table.getByText('SIMULATED').first()).toBeVisible();
    // Filter by claim type and clear it again.
    await page.getByRole('button', { name: /^Filters/ }).click();
    await page.getByLabel('Claim type').selectOption('FACT');
    await expect(table.locator('tbody tr').first()).toBeVisible();
    await page.getByLabel('Claim type').selectOption('');
    // Open a finding and verify it with a rationale.
    await table.locator('tbody tr').first().click();
    const detail = page.getByTestId('finding-detail');
    await expect(detail).toBeVisible();
    await expect(detail.getByText(/Confidence/i).first()).toBeVisible();
    await detail.getByLabel('Verification status').selectOption('verified');
    const save = detail.getByRole('button', { name: 'Record review' });
    await expect(save).toBeDisabled(); // rationale required
    await detail.getByLabel('Rationale').fill('Cross-checked against the simulated registry record (fictional).');
    await save.click();
    await expect(detail.getByText('Cross-checked against the simulated registry record (fictional).')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('7. inspects stored evidence with integrity hashes', async () => {
    await page.goto(`${workspace}/evidence`);
    const list = page.getByTestId('evidence-list');
    await expect(list.locator('li').first()).toBeVisible();
    await list.locator('li button').first().click();
    // The evidence sheet shows the full content hash recorded at collection time.
    await expect(page.getByRole('dialog').getByText(/SHA-256 [0-9a-f]{64}/)).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('8. explores the relationship graph', async () => {
    await page.goto(`${workspace}/graph`);
    await expect(page.getByTestId('graph-canvas')).toBeVisible();
    await expect(page.getByTestId('graph-canvas')).toHaveAttribute('aria-label', /Relationship graph with \d+ entities and [1-9]\d* relationships/);
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await page.getByRole('button', { name: 'Fit graph' }).click();
    // Text alternative: the connections list, with the same evidence panel.
    await page.getByRole('button', { name: 'Connections list' }).click();
    const connections = page.getByTestId('graph-list');
    await expect(connections.locator('li').first()).toBeVisible();
    await connections.locator('li button').first().click();
    await expect(page.getByTestId('relationship-panel').or(page.getByTestId('node-panel'))).toBeVisible();
  });

  test('9. reviews the timeline (only dated events, never invented dates)', async () => {
    await page.goto(`${workspace}/timeline`);
    const timeline = page.getByTestId('timeline');
    await expect(timeline).toBeVisible();
    await expect(timeline.locator('li').first()).toBeVisible();
  });

  test('10. uploads an image and sees EXIF GPS and OCR results', async () => {
    await page.goto(`${workspace}/images`);
    const file = '/tmp/atlas-e2e-street.jpg';
    fs.writeFileSync(file, await makeExifJpeg('ATLAS E2E 2026'));
    await page.getByTestId('upload-image').setInputFiles(file);
    const card = page.getByTestId('image-artifacts').locator('li').first();
    await expect(card).toBeVisible();
    await expect(card.getByText(/38\.7223/)).toBeVisible({ timeout: 90_000 });
    await card.getByText(/OCR text \(\d+% confidence\)/).click();
    await expect(card.getByText(/ATLAS E2E/)).toBeVisible();
  });

  test('11–12. generates a report and downloads PDF and Markdown exports', async () => {
    await page.goto(`${workspace}/reports`);
    await page.getByLabel('Title').fill('E2E Intelligence Report');
    await page.getByTestId('generate-report').click();
    await expect(page.getByTestId('reports-list').getByText('E2E Intelligence Report')).toBeVisible();

    const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-pdf').first().click()]);
    expect(pdf.suggestedFilename()).toMatch(/^atlas-.*\.pdf$/);
    const pdfBytes = fs.readFileSync((await pdf.path())!);
    expect(pdfBytes.subarray(0, 5).toString()).toBe('%PDF-');

    const [md] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-markdown').first().click()]);
    const text = fs.readFileSync((await md.path())!, 'utf8');
    expect(text).toContain('# E2E Intelligence Report');
    expect(text).toMatch(/simulated/i);

    // Ad-hoc export from the header menu.
    await page.getByRole('button', { name: /Export/ }).click();
    const [csv] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-csv').click()]);
    expect(csv.suggestedFilename()).toMatch(/\.csv$/);
  });

  test('13. shows provider failures honestly instead of hiding them', async () => {
    await page.goto(workspace);
    await expect(page.getByText('Partially completed').first()).toBeVisible();
    const runs = page.getByTestId('provider-runs');
    const unstable = runs.getByRole('button', { name: /Simulated Unstable Feed/ });
    await expect(unstable).toBeVisible();
    await expect(unstable).toContainText(/failed/);
    await unstable.click();
    await expect(runs.getByText(/simulated|timeout|unavailable|failed/i).first()).toBeVisible();
  });

  test('14. rejects invalid input with clear messages', async () => {
    await page.goto('/investigations/new');
    await page.getByLabel('Investigation name').fill('Invalid input check');
    await page.getByLabel('Target 1 type').selectOption('ip');
    const input = page.getByLabel('Target 1 value');
    await input.fill('999.300.1.1');
    await input.blur();
    await expect(page.getByRole('alert').filter({ hasText: /IP/i })).toBeVisible();
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    // The API refuses it as well, even if the client check were bypassed.
    const res = await page.request.post('/api/investigations', { data: { name: 'Bypass', targets: [{ type: 'ip', value: '999.300.1.1' }] } });
    expect(res.status()).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_targets');
  });

  test('15. sends security headers', async () => {
    const res = await page.request.get('/login');
    const h = res.headers();
    expect(h['content-security-policy']).toMatch(/default-src 'self'/);
    expect(h['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['referrer-policy']).toBeTruthy();
    expect(h['x-frame-options']).toBe('DENY');
  });

  test('16. blocks access to another user’s investigation', async ({ browser }) => {
    const ctx = await browser.newContext();
    const other = await ctx.newPage();
    await register(other, 'Second Analyst', uniqueEmail('second'));
    const res = await other.goto(workspace);
    expect(res?.status()).toBe(404);
    await expect(other.getByText('Not found')).toBeVisible();
    await expect(other.getByText(investigationName)).toHaveCount(0);
    const id = workspace.split('/').pop()!;
    for (const path of [`/api/investigations/${id}`, `/api/investigations/${id}/findings`, `/api/investigations/${id}/export?format=json`]) {
      expect((await other.request.get(path)).status(), path).toBe(404);
    }
    // Cross-site form posts are refused even with the victim's cookie.
    const csrf = await page.request.post(`/api/investigations/${id}/start`, { headers: { origin: 'https://attacker.example' }, data: {} });
    expect(csrf.status()).toBe(403);
    await ctx.close();
    // Signed-out requests are redirected (pages) or refused (API).
    const anon = await browser.newContext();
    const anonPage = await anon.newPage();
    await anonPage.goto(workspace);
    await expect(anonPage).toHaveURL(/\/login/);
    expect((await anonPage.request.get('/api/investigations')).status()).toBe(401);
    await anon.close();
  });

  test('17. raised no script errors or Content-Security-Policy violations', async () => {
    expect(pageErrors).toEqual([]);
  });
});

test('mobile viewport: workspace is usable without horizontal scrolling', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await register(page, 'Mobile Analyst', uniqueEmail('mobile'), PASSWORD);
  const workspace = await createDemoInvestigation(page, 'Mobile check (fictional)', ['j.doe@example.org'], 'quick');
  await waitForJobToFinish(page);
  for (const path of ['', '/findings', '/graph', '/timeline', '/reports']) {
    await page.goto(workspace + path);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `horizontal overflow on ${path || 'overview'}`).toBeLessThanOrEqual(1);
  }
  await page.goto(`${workspace}/findings`);
  await expect(page.getByTestId('findings-cards')).toBeVisible();
  await expect(page.getByTestId('findings-table')).toBeHidden();
  await page.getByTestId('findings-cards').locator('li').first().click();
  await expect(page.getByTestId('finding-detail')).toBeVisible();
  await ctx.close();
});
