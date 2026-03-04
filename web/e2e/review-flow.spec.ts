import { test, expect } from '@playwright/test';

test.describe('Review Flow', () => {
  test('history page shows empty state when no games', async ({ page }) => {
    // Clear IndexedDB
    await page.goto('/history');
    await page.evaluate(() => {
      const req = indexedDB.deleteDatabase('euchre-trainer');
      return new Promise((resolve) => { req.onsuccess = resolve; req.onerror = resolve; });
    });
    await page.reload();

    await expect(page.locator('text=No games played yet')).toBeVisible({ timeout: 5_000 });
  });

  test('review page handles missing game gracefully', async ({ page }) => {
    await page.goto('/review/99999');

    // Should show loading or empty state — not crash
    const content = page.locator('.review-page, .loading');
    await expect(content.first()).toBeVisible({ timeout: 5_000 });
  });

  test('settings persist across navigation', async ({ page }) => {
    await page.goto('/settings');

    // Click Advanced difficulty button (3rd button, index 2)
    const advancedBtn = page.locator('.difficulty-btn', { hasText: 'Advanced' });
    await advancedBtn.click();

    // Verify it's selected
    await expect(advancedBtn).toHaveClass(/active/, { timeout: 2_000 });

    // Navigate away and back
    await page.goto('/history');
    await page.goto('/settings');

    // Should still be Advanced (active class persisted via Zustand)
    await expect(page.locator('.difficulty-btn.active')).toContainText('Advanced', { timeout: 2_000 });
  });

  test('game list items navigate to review page', async ({ page }) => {
    await page.goto('/history');

    const gameItems = page.locator('.game-list li');
    const count = await gameItems.count();

    if (count > 0) {
      await gameItems.first().click();
      await expect(page).toHaveURL(/\/review\/\d+/);
    } else {
      // No games — just verify empty state message is shown
      await expect(page.locator('text=No games played yet')).toBeVisible();
    }
  });
});
