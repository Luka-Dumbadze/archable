// apps/api/src/routes/github.ts: POST /v1/webhooks/github, the archable-architect App's webhook (plan §7.1, §7.2).
// Every delivery is verified with app.webhooks.verifyAndReceive before any handler runs: the signature covers the
// raw body, so it is read as text. Handlers for pull_request, pull_request_review and push are registered on the App
// (approvals ledger and card supersede: P4.D2.6, P4.D2.7).
import type { App } from 'octokit';
import { Hono } from 'hono';

export interface GithubDeps {
  app: App;
  log(event: string, data: Record<string, unknown>): void;
}

export function githubWebhookRoutes(d: GithubDeps) {
  const routes = new Hono();
  routes.post('/v1/webhooks/github', async (c) => {
    const id = c.req.header('x-github-delivery');
    const name = c.req.header('x-github-event');
    const signature = c.req.header('x-hub-signature-256');
    if (!id || !name || !signature) return c.json({ error: 'unauthorized' }, 401);
    const payload = await c.req.text();
    // verifyAndReceive, in its two steps, so a bad signature (401, no handler ran) and a failing handler (500) can't
    // be confused: @octokit/webhooks reports both as an AggregateError.
    if (!(await d.app.webhooks.verify(payload, signature).catch(() => false))) {
      d.log('github.webhook_rejected', { delivery: id, event: name });
      return c.json({ error: 'unauthorized' }, 401);
    }
    let event: unknown;
    try { event = JSON.parse(payload); } catch { return c.json({ error: 'bad_request' }, 400); }
    try {
      await d.app.webhooks.receive({ id, name: name as never, payload: event as never });
    } catch (e) {
      d.log('github.handler_failed', { delivery: id, event: name, error: String(e) });
      return c.json({ error: 'handler_failed' }, 500);
    }
    return c.json({ ok: true });
  });
  return routes;
}
