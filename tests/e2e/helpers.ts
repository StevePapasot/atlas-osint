import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

export const PASSWORD = 'e2e correct horse battery';

export function uniqueEmail(prefix: string) {
  return `${prefix}-${randomUUID().slice(0, 8)}@atlas-e2e.example`;
}

export async function register(page: Page, name: string, email: string, password = PASSWORD) {
  await page.goto('/register');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByLabel(/acceptable-use policy/).check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('**/dashboard');
}

export async function login(page: Page, email: string, password = PASSWORD) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/dashboard');
}

/** Creates a demo investigation through the UI and returns its workspace URL. */
export async function createDemoInvestigation(page: Page, name: string, targets: string[], depth: 'quick' | 'standard' | 'deep' = 'standard') {
  await page.goto('/investigations/new');
  await page.getByLabel('Investigation name').fill(name);
  await page.getByText('Demo (simulated)').click();
  for (const [i, value] of targets.entries()) {
    if (i > 0) await page.getByRole('button', { name: /add target/i }).first().click();
    const input = page.getByLabel(`Target ${i + 1} value`);
    await input.fill(value);
    await input.blur();
    await expect(page.getByText('Normalised:').nth(i)).toBeVisible();
  }
  await page.locator(`input[name=depth][value=${depth}]`).check();
  await page.getByTestId('create-and-start').click();
  await page.waitForURL(/\/investigations\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('investigation-name')).toHaveText(name);
  return page.url();
}

export async function waitForJobToFinish(page: Page, timeout = 90_000) {
  await expect(page.getByText(/^(Partially completed|Completed)$/).first()).toBeVisible({ timeout });
}
