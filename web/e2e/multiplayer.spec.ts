import { test, expect, type Page } from '@playwright/test';

test.describe('Multiplayer', () => {
  test('lobby: guest login shows profile with elo and milk coins', async ({ page }) => {
    await page.goto('/lobby');

    await expect(page.locator('h2', { hasText: 'Play Online' })).toBeVisible();
    await page.click('button:has-text("Play as Guest")');

    // Profile card appears with starting rating and signup coins
    await expect(page.locator('text=Rating')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=1200')).toBeVisible();
    await expect(page.locator('text=🥛 100')).toBeVisible();
    await expect(page.locator('button:has-text("Find Match")')).toBeVisible();
  });

  test('queue screen appears and can be cancelled', async ({ page }) => {
    await page.goto('/lobby');
    await page.click('button:has-text("Play as Guest")');
    await page.click('button:has-text("Find Match")');

    await expect(page.locator('h2', { hasText: 'Finding a match' })).toBeVisible({ timeout: 10_000 });
    await page.click('button:has-text("Cancel")');
    await expect(page.locator('button:has-text("Find Match")')).toBeVisible({ timeout: 5_000 });
  });

  test('four players get matched into one live game', async ({ browser }) => {
    test.setTimeout(120_000);

    // Four independent browser sessions (separate storage → separate guests)
    const pages: Page[] = [];
    for (let i = 0; i < 4; i++) {
      const context = await browser.newContext();
      pages.push(await context.newPage());
    }

    try {
      for (const p of pages) {
        await p.goto('/lobby');
        await p.click('button:has-text("Play as Guest")');
        await p.click('button:has-text("Find Match")', { timeout: 10_000 });
      }

      // All four land on the same table: game UI appears for everyone
      for (const p of pages) {
        await expect(p.locator('.game-table')).toBeVisible({ timeout: 30_000 });
        // Each player sees their own 5 face-up cards
        await expect(p.locator('.hand-bottom .card:not(.card-back)').first()).toBeVisible({
          timeout: 10_000,
        });
      }

      // Someone is on turn: at least one player sees the bidding panel
      const biddingVisible = await Promise.all(
        pages.map((p) =>
          p
            .locator('.bidding-panel')
            .isVisible({ timeout: 1_000 })
            .catch(() => false),
        ),
      );
      // The first bidder's panel may take a moment — poll across players
      if (!biddingVisible.some(Boolean)) {
        await expect
          .poll(
            async () => {
              for (const p of pages) {
                if (await p.locator('.bidding-panel').isVisible().catch(() => false)) return true;
              }
              return false;
            },
            { timeout: 15_000 },
          )
          .toBe(true);
      }

      // The player on turn passes — the bid log updates for everyone
      for (const p of pages) {
        if (await p.locator('.bidding-panel').isVisible().catch(() => false)) {
          await p.click('.bidding-panel button:has-text("Pass")');
          break;
        }
      }
      await expect
        .poll(
          async () => {
            for (const p of pages) {
              const count = await p.locator('.bid-indicator').count();
              if (count > 0) return true;
            }
            return false;
          },
          { timeout: 10_000 },
        )
        .toBe(true);
    } finally {
      for (const p of pages) {
        await p.context().close();
      }
    }
  });
});
