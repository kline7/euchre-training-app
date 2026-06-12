import { createMiddleware } from 'hono/factory';

/**
 * Minimal in-memory per-IP rate limiter for the unauthenticated endpoints
 * (register / login / guest). Fixed-window counters; fine for a single
 * process, which is the deployment shape (see DEPLOYMENT.md).
 *
 * Behind the reverse proxy the client IP arrives in X-Forwarded-For.
 */
export function rateLimit(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return createMiddleware(async (c, next) => {
    const forwarded = c.req.header('x-forwarded-for');
    const ip = forwarded?.split(',')[0]?.trim() || 'local';

    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }
    entry.count += 1;

    if (entry.count > limit) {
      return c.json({ error: 'Too many requests — try again shortly' }, 429);
    }

    // Opportunistic cleanup so the map cannot grow unbounded
    if (hits.size > 10_000) {
      for (const [key, value] of hits) {
        if (value.resetAt <= now) hits.delete(key);
      }
    }

    await next();
  });
}
