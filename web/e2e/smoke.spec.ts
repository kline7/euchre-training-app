import { test, expect } from '@playwright/test';

test.describe('Euchre Training App — Smoke Tests', () => {
  test('1. App loads and starts a game', async ({ page }) => {
    await page.goto('/');

    // Should see the nav links
    await expect(page.locator('nav a', { hasText: 'Play' })).toBeVisible();
    await expect(page.locator('nav a', { hasText: 'History' })).toBeVisible();
    await expect(page.locator('nav a', { hasText: 'Settings' })).toBeVisible();

    // Start screen → game table
    await page.click('button:has-text("Start Game")');
    await expect(page.locator('.game-table')).toBeVisible({ timeout: 30_000 });
  });

  test('2. Settings page renders controls', async ({ page }) => {
    await page.goto('/settings');
    // 4 difficulty buttons + 3 checkboxes (hints, auto-analyze, trump rule)
    await expect(page.locator('.difficulty-btn')).toHaveCount(4, { timeout: 5_000 });
    await expect(page.locator('input[type="checkbox"]')).toHaveCount(3, { timeout: 5_000 });
    // The house-rule toggle is present and defaults to ON
    const ruleToggle = page.locator('label', { hasText: 'Trump must be broken' }).locator('input');
    await expect(ruleToggle).toBeChecked();
  });

  test('3. History page loads', async ({ page }) => {
    await page.goto('/history');
    // Should show the Game History heading specifically
    await expect(page.locator('h1, h2').filter({ hasText: 'History' })).toBeVisible({ timeout: 5_000 });
  });

  test('4. Navigation between pages works', async ({ page }) => {
    await page.goto('/');

    // Navigate to settings
    await page.click('nav a:has-text("Settings")');
    await expect(page).toHaveURL(/settings/);

    // Navigate to history
    await page.click('nav a:has-text("History")');
    await expect(page).toHaveURL(/history/);

    // Navigate back to play
    await page.click('nav a:has-text("Play")');
    await expect(page).toHaveURL('/');
  });

  test('5. WASM engine initializes or shows error', async ({ page }) => {
    // Listen for console errors
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/');
    await page.click('button:has-text("Start Game")');
    // Give WASM time to load
    await page.waitForTimeout(5_000);

    // Check what's on the page
    const html = await page.locator('main').innerHTML();
    const hasGame = html.includes('game-table') || html.includes('bidding');
    const hasError = html.includes('Engine Error');
    const hasLoading = html.includes('Loading') || html.includes('loading');

    // App should be in one of these states — not a blank page
    expect(hasGame || hasError || hasLoading).toBeTruthy();
  });
});
