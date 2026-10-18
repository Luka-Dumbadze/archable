import { createHmac, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { githubApp } from '@archable/governance';
import { githubWebhookRoutes } from './github';

// A throwaway App key: verifyAndReceive needs only the webhook secret, but the App constructor wants a key.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SECRET = 'test-webhook-secret';
const app = githubApp({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), GITHUB_WEBHOOK_SECRET: SECRET });

const seen: string[] = [];
app.webhooks.on('pull_request', async ({ payload }) => { seen.push(`pull_request.${payload.action}`); });
app.webhooks.on('push', async () => { throw new Error('handler bug'); });
const logs: string[] = [];
const routes = githubWebhookRoutes({ app, log: (e) => logs.push(e) });

const body = JSON.stringify({ action: 'opened', number: 1, pull_request: { number: 1, head: { sha: 'a'.repeat(40) } },
  repository: { full_name: 'archable-tenants/marani' }, installation: { id: 1 } });
const sign = (payload: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
const post = (headers: Record<string, string>, payload = body) =>
  routes.request('/v1/webhooks/github', { method: 'POST', body: payload, headers: { 'content-type': 'application/json', ...headers } });

describe('POST /v1/webhooks/github', () => {
  it('a correctly signed delivery reaches its handler', async () => {
    const r = await post({ 'x-github-delivery': 'd-1', 'x-github-event': 'pull_request', 'x-hub-signature-256': sign(body) });
    expect(r.status).toBe(200);
    expect(seen).toEqual(['pull_request.opened']);
  });

  it('a wrong signature gets 401 and never reaches a handler', async () => {
    const before = seen.length;
    const r = await post({ 'x-github-delivery': 'd-2', 'x-github-event': 'pull_request', 'x-hub-signature-256': sign(body, 'wrong-secret') });
    expect(r.status).toBe(401);
    expect(seen.length).toBe(before);
    expect(logs).toContain('github.webhook_rejected');
  });

  it('a body changed after signing gets 401', async () => {
    const r = await post({ 'x-github-delivery': 'd-3', 'x-github-event': 'pull_request', 'x-hub-signature-256': sign(body) }, body.replace('opened', 'closed'));
    expect(r.status).toBe(401);
  });

  it('missing signature headers get 401', async () => {
    expect((await post({ 'x-github-event': 'pull_request' })).status).toBe(401);
  });

  it('a verified delivery whose handler fails is our 500, not a 401', async () => {
    const payload = JSON.stringify({ ref: 'refs/heads/archable/d-1', repository: { full_name: 'archable-tenants/marani' } });
    const r = await post({ 'x-github-delivery': 'd-4', 'x-github-event': 'push', 'x-hub-signature-256': sign(payload) }, payload);
    expect(r.status).toBe(500);
    expect(logs).toContain('github.handler_failed');
  });
});
