import { test, expect } from '@playwright/test';

test.describe('Euchre Training App — Smoke Tests', () => {
  test('1. App loads and shows game table', async ({ page }) => {
    await page.goto('/');

    // Should see the nav links
    await expect(page.locator('nav a', { hasText: 'Play' })).toBeVisible();
    await expect(page.locator('nav a', { hasText: 'History' })).toBeVisible();
    await expect(page.locator('nav a', { hasText: 'Settings' })).toBeVisible();

    // Should see the game table (or loading state)
    const gameTable = page.locator('.game-table, .loading');
    await expect(gameTable).toBeVisible({ timeout: 10_000 });
  });

  test('2. Settings page renders controls', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.locator('select, input')).toHaveCount(3, { timeout: 5_000 });
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
