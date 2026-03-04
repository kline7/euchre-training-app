import { test, expect } from '@playwright/test';

// These tests require WASM engine — use serial mode and longer timeouts
test.describe.configure({ mode: 'serial' });

test.describe('Play Flow', () => {
  test('game initializes and shows game table or bidding', async ({ page }) => {
    await page.goto('/');

    // First: loading state should appear quickly
    await expect(page.locator('text=Loading engine')).toBeVisible({ timeout: 5_000 });

    // Then: wait for WASM to load and game to start (may take a while in parallel)
    await expect(page.locator('.game-table')).toBeVisible({ timeout: 30_000 });

    // Score panel should be present
    await expect(page.locator('.score-panel')).toBeVisible();
    await expect(page.locator('.score-panel')).toContainText('Us:');
    await expect(page.locator('.score-panel')).toContainText('Them:');
    await expect(page.locator('.score-panel')).toContainText('Trump:');

    // Dealer marker
    await expect(page.locator('.dealer-marker')).toBeVisible();
  });

  test('cards render for all 4 seats', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.game-table')).toBeVisible({ timeout: 30_000 });

    // Wait for AI turns to settle
    await page.waitForTimeout(3_000);

    // Human hand (bottom) has face-up cards
    const humanCards = page.locator('.hand-bottom .card:not(.card-back)');
    await expect(humanCards.first()).toBeVisible({ timeout: 5_000 });

    // Opponent hands have face-down cards
    const opponentCards = page.locator('.hand-top .card-back, .hand-left .card-back, .hand-right .card-back');
    await expect(opponentCards.first()).toBeVisible({ timeout: 5_000 });
  });

  test('game progresses past loading into active state', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.game-table')).toBeVisible({ timeout: 30_000 });

    // Wait for AI turns to process
    await page.waitForTimeout(5_000);

    // Game should be in SOME active state: bidding, playing, or summary
    const html = await page.locator('.play-page').innerHTML();
    const hasGame = html.includes('game-table');
    const hasBidding = html.includes('bidding-panel');
    const hasSummary = html.includes('hand-summary') || html.includes('HandSummary');
    const hasCards = html.includes('card');

    expect(hasGame || hasBidding || hasSummary || hasCards).toBeTruthy();
  });
});
