import { test, expect, type Page } from '@playwright/test';

async function guestLogin(page: Page): Promise<string> {
  await page.goto('/lobby');
  await page.click('button:has-text("Play as Guest")');
  await expect(page.locator('button', { hasText: 'Find Match (Solo)' })).toBeVisible({
    timeout: 10_000,
  });
  const heading = await page.locator('h2').first().innerText();
  return heading.trim().split(/\s+/)[0]; // username precedes the division badge
}

test.describe('Team lobby', () => {
  test('friends → party → divisions → play vs AI', async ({ browser }) => {
    test.setTimeout(120_000);

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const a = await ctxA.newPage();
    const b = await ctxB.newPage();

    try {
      const nameA = await guestLogin(a);
      const nameB = await guestLogin(b);

      // Divisions are visible on profiles (new accounts are Silver, 1200)
      await expect(a.locator('h2').first()).toContainText('Silver');

      // B sends A a friend request
      await b.fill('input[placeholder="Add friend by username"]', nameA);
      await b.click('button:has-text("Add")');
      await expect(b.locator('text=Pending…')).toBeVisible({ timeout: 5_000 });

      // A accepts (reload to refresh the friends list immediately)
      await a.reload();
      await expect(a.locator(`text=${nameB}`)).toBeVisible({ timeout: 10_000 });
      await a.click('button:has-text("Accept")');
      await expect(a.locator('button:has-text("Invite to Team")')).toBeVisible({ timeout: 5_000 });

      // A invites B to a team — B gets a live invite over the WebSocket
      await a.click('button:has-text("Invite to Team")');
      await expect(b.locator(`text=${nameA} invited you to their team`)).toBeVisible({
        timeout: 10_000,
      });
      await b.click('button:has-text("Accept")');

      // Both see the team panel with the combined team rating and division
      for (const p of [a, b]) {
        await expect(p.locator('h3', { hasText: 'Your Team' })).toBeVisible({ timeout: 10_000 });
        await expect(p.locator('text=Team rating:')).toBeVisible();
        await expect(p.locator('button:has-text("Queue as Team (Rated)")')).toBeVisible();
      }

      // Leader starts a practice match vs AI
      await a.click('button:has-text("Play vs AI (Practice)")');

      // Both players land at the same table against the bots
      for (const p of [a, b]) {
        await expect(p.locator('.game-table')).toBeVisible({ timeout: 30_000 });
        await expect(p.locator('text=Bot Lefty')).toBeVisible({ timeout: 10_000 });
        await expect(p.locator('text=Bot Righty')).toBeVisible();
        // Each human sees their own 5 cards
        await expect(p.locator('.hand-bottom .card:not(.card-back)').first()).toBeVisible({
          timeout: 10_000,
        });
      }

      // The two humans are partners: both see the partner emoji on each other
      await expect(a.locator(`text=🤝 ${nameB}`)).toBeVisible();
      await expect(b.locator(`text=🤝 ${nameA}`)).toBeVisible();
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test('team leaderboard tab renders', async ({ page }) => {
    await page.goto('/lobby');
    await page.click('button:has-text("Play as Guest")');
    await expect(page.locator('h3', { hasText: 'Leaderboard' })).toBeVisible({ timeout: 10_000 });
    await page.click('button:has-text("Teams")');
    // Either an empty-state message or a populated table
    await expect(
      page.locator('text=No rated team games yet.').or(page.locator('table th', { hasText: 'Team' })),
    ).toBeVisible({ timeout: 5_000 });
  });
});
