// Integration test of the channel wrappers against the real database (P3.D2.1), following plan §9.3's D2–D4 groups.
// The wrappers use two roles, so one rolled-back transaction can't hold them: the test makes its own tenant and
// deletes it at the end (cascade). Skipped without DATABASE_URL_RUNTIME / DATABASE_URL_CONTROL (CI has neither).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBundles } from '@archable/runtime';
import { createChannelStore } from './channel-store';
import { withTenant } from './db';

const live = Boolean(process.env.DATABASE_URL_RUNTIME && process.env.DATABASE_URL_CONTROL);
const h = (s: string) => createHash('sha256').update(s).digest();
const rand = (n: number) => Math.floor(Math.random() * 10 ** n);

describe.skipIf(!live)('channel store against archable (D2–D4)', () => {
  const runtime = postgres(process.env.DATABASE_URL_RUNTIME!, { prepare: false, max: 2 });
  const control = postgres(process.env.DATABASE_URL_CONTROL!, { prepare: false, max: 2 });
  const bundles = createBundles((tenantId, fn) => withTenant(runtime, tenantId, fn));
  const store = createChannelStore({ runtime, control, bundles });
  const tenant = randomUUID();
  const slug = `zz-p3-${randomBytes(3).toString('hex')}`;
  const owner = { id: randomUUID(), tg: 7_000_000_000 + rand(8) };
  const staff = { id: randomUUID(), tg: owner.tg + 1 };
  const bot = { a: 8_000_000_000 + rand(8), b: 0, via: 9_000_000_000 + rand(8) };
  bot.b = bot.a + 1;
  const hooks = { a: randomUUID(), b: randomUUID() };
  const bc = `bc-${randomBytes(6).toString('hex')}`;

  beforeAll(async () => {
    await withTenant(control, tenant, async (tx) => {
      await tx`insert into public.tenants (id, slug, name, os_name, status) values (${tenant}, ${slug}, 'P3 test', 'P3 OS', 'live')`;
      await tx`insert into public.memberships (id, tenant_id, role, display_name, tg_user_id) values
               (${owner.id}, ${tenant}, 'owner', 'Owner', ${owner.tg}), (${staff.id}, ${tenant}, 'staff', 'Staff', ${staff.tg})`;
    });
  });

  afterAll(async () => {
    await withTenant(control, tenant, (tx) => tx`delete from public.tenants where id = ${tenant}`);
    await runtime.end();
    await control.end();
  });

  it('ownerTenants finds the owner’s tenant, not the staff member’s', async () => {
    expect((await store.ownerTenants(owner.tg)).map((t) => [t.slug, t.membership_id])).toEqual([[slug, owner.id]]);
    expect(await store.ownerTenants(staff.tg)).toEqual([]);
  });

  describe('D2 tenant bot', () => {
    it('only the owner can bind', async () => {
      await expect(store.bindTenantBot({ tenantId: tenant, membershipId: staff.id, botId: bot.a, username: 'p3_bot', token: 'TOKEN-A', hookId: hooks.a, secretHash: h('sa') }))
        .rejects.toMatchObject({ code: '42501' });
    });

    it('binding makes the hook resolve, with the Vault name and not the token', async () => {
      await store.bindTenantBot({ tenantId: tenant, membershipId: owner.id, botId: bot.a, username: 'p3_bot', token: 'TOKEN-A', hookId: hooks.a, secretHash: h('sa') });
      const hook = await store.resolveBotHook(hooks.a);
      expect(hook).toMatchObject({ tenant_id: tenant, bot_id: bot.a, token_secret: `${slug}/tg_bot_token` });
      expect(Buffer.compare(hook!.hook_secret_hash, h('sa'))).toBe(0);
    });

    it('rebinding revokes the old hook', async () => {
      await store.bindTenantBot({ tenantId: tenant, membershipId: owner.id, botId: bot.b, username: 'p3_bot2', token: 'TOKEN-B', hookId: hooks.b, secretHash: h('sb') });
      expect(await store.resolveBotHook(hooks.a)).toBeNull();
      expect((await store.resolveBotHook(hooks.b))?.bot_id).toBe(bot.b);
    });

    it('a Telegram retry is seen once', async () => {
      const update = rand(9);
      expect(await store.firstSeen(bot.b, update)).toBe(true);
      expect(await store.firstSeen(bot.b, update)).toBe(false);
    });

    it('revoking the channel stops resolution', async () => {
      const hook = await store.resolveBotHook(hooks.b);
      await store.revokeChannel(tenant, hook!.channel_id);
      expect(await store.resolveBotHook(hooks.b)).toBeNull();
    });
  });

  describe('D3 Business', () => {
    const args = (o: Partial<{ canReply: boolean; enabled: boolean; user: number }> = {}) =>
      ({ viaBot: bot.via, connectionId: bc, user: o.user ?? owner.tg, userChat: o.user ?? owner.tg, canReply: o.canReply ?? false, enabled: o.enabled ?? true });

    it('no intent: no_intent', async () => {
      expect(await store.bindBusinessConnection(args())).toEqual({ outcome: 'no_intent', tenant_id: null });
    });

    it('an intent for another person’s membership: not_owner', async () => {
      await store.createLinkIntent(tenant, owner.id, staff.tg);
      expect((await store.bindBusinessConnection(args({ user: staff.tg }))).outcome).toBe('not_owner');
    });

    it('bound in suggest mode, then rights edited to reply', async () => {
      await store.createLinkIntent(tenant, owner.id, owner.tg);
      expect(await store.bindBusinessConnection(args())).toEqual({ outcome: 'bound', tenant_id: tenant });
      expect(await store.resolveBusinessConnection(bot.via, bc)).toMatchObject({ tenant_id: tenant, business_user_id: owner.tg, can_reply: false });
      expect((await store.bindBusinessConnection(args({ canReply: true }))).outcome).toBe('updated');
      expect((await store.resolveBusinessConnection(bot.via, bc))?.can_reply).toBe(true);
    });

    it('a wrong bot id resolves nothing; disconnect stops resolution', async () => {
      expect(await store.resolveBusinessConnection(bot.via + 1, bc)).toBeNull();
      expect((await store.bindBusinessConnection(args({ enabled: false }))).outcome).toBe('disconnected');
      expect(await store.resolveBusinessConnection(bot.via, bc)).toBeNull();
    });
  });

  describe('P3.D2.2 widget config and Business recovery', () => {
    it('GET /v1/widget/config/marani: Georgian and English labels, the brand colour, embed origins', async () => {
      expect(await store.widgetConfig('marani')).toEqual({
        greeting: { ka: 'გამარჯობა! რა ღვინოს ეძებთ?', en: 'Hi! Looking for a wine?' },
        launcher: { label: { ka: 'მოგვწერეთ', en: 'Chat with us' }, position: 'right' },
        brand: '#7B1E3A',
        embed_origins: ['https://marani.ge'],
      });
    });

    it('unknown tenant, or a tenant without live web chat: null', async () => {
      expect(await store.widgetConfig('zz-nobody')).toBeNull();
      expect(await store.widgetConfig(slug)).toBeNull();       // the test tenant has no bundle and no web channel yet
    });

    const fetched = (id: string, user: number) => async (asked: string) => {
      expect(asked).toBe(id);
      return { id, user: { id: user }, user_chat_id: user, is_enabled: true, rights: { can_reply: true } };
    };

    it('a message for an unknown connection without an intent binds nothing and says why', async () => {
      const id = `bc-r-${randomBytes(4).toString('hex')}`;
      expect(await store.recoverBusinessConnection(fetched(id, owner.tg), bot.via, id)).toEqual({ outcome: 'no_intent', connection: null });
    });

    it('with the owner’s open intent, the fetched connection is bound and resolves; a second call finds it known', async () => {
      const id = `bc-r-${randomBytes(4).toString('hex')}`;
      await store.createLinkIntent(tenant, owner.id, owner.tg);
      const r = await store.recoverBusinessConnection(fetched(id, owner.tg), bot.via, id);
      expect(r).toMatchObject({ outcome: 'bound', connection: { tenant_id: tenant, business_user_id: owner.tg, can_reply: true } });
      expect((await store.recoverBusinessConnection(async () => { throw new Error('not called'); }, bot.via, id)).outcome).toBe('known');
    });
  });

  describe('D4 web sessions', () => {
    const secret = h(`ws-${randomUUID()}`);
    let session: { tenant_id: string; session_id: string; conversation_id: string } | null = null;

    it('chat off returns nothing', async () => {
      expect(await store.openSession(slug, 'prod', secret, 'https://p3.example')).toBeNull();
    });

    it('open, then resume by secret hash returns the same session and the slug', async () => {
      await withTenant(control, tenant, (tx) => tx`insert into public.channel_connections (tenant_id, channel_key, kind) values (${tenant}, 'web_chat', 'web')`);
      session = await store.openSession(slug, 'prod', secret, 'https://p3.example');
      expect(session).toMatchObject({ tenant_id: tenant });
      expect(await store.resumeSession(secret)).toEqual({ ...session, env: 'prod', slug });
      expect(await store.resumeSession(h('unknown'))).toBeNull();
    });

    it('a bad env is rejected', async () => {
      await expect(store.openSession(slug, 'staging' as never, h('x'), null)).rejects.toMatchObject({ code: '22023' });
    });

    it('the new conversation has no traffic; pausing it sets agent_paused_until', async () => {
      const c = { tid: tenant, sid: session!.session_id, cid: session!.conversation_id, env: 'prod' as const };
      expect(await store.recentInbound(c, 60)).toBe(0);
      expect(await store.outboundAfter(c, 0)).toEqual([]);
      expect(await store.existingReply(c, randomUUID())).toBeNull();
      await store.pauseAgent(tenant, `ws_${session!.session_id}`, 30);
      const [conv] = await withTenant(runtime, tenant, (tx) => tx<{ paused: boolean }[]>`
        select agent_paused_until > now() + interval '29 minutes' as paused from public.conversations where id = ${session!.conversation_id}`);
      expect(conv?.paused).toBe(true);
    });

    it('messages come back as the chat API’s authors, and a retried client_msg_id finds its reply', async () => {
      const c = { tid: tenant, sid: session!.session_id, cid: session!.conversation_id, env: 'prod' as const };
      const turn = randomUUID();
      const clientMsgId = randomUUID();
      await withTenant(runtime, tenant, (tx) => tx`
        insert into public.messages (tenant_id, conversation_id, turn_id, direction, author, body, spec_digest, external_id) values
          (${tenant}, ${c.cid}, ${turn}, 'in', 'customer', 'saperavi?', 'sha256:x', ${clientMsgId}),
          (${tenant}, ${c.cid}, ${turn}, 'out', 'agent:cellar_master', '35.00 GEL', 'sha256:x', null)`);
      expect(await store.recentInbound(c, 60)).toBe(1);
      const reply = await store.existingReply(c, clientMsgId);
      expect(reply).toMatchObject({ author: 'agent', text: '35.00 GEL' });
      expect((await store.outboundAfter(c, 0)).map((m) => m.text)).toEqual(['35.00 GEL']);
      expect(await store.outboundAfter(c, reply!.id)).toEqual([]);
    });

    it('revoking web chat closes it to new sessions', async () => {
      const [ch] = await withTenant(control, tenant, (tx) => tx<{ id: string }[]>`select id from public.channel_connections where tenant_id = ${tenant} and kind = 'web'`);
      await store.revokeChannel(tenant, ch!.id);
      expect(await store.openSession(slug, 'prod', h(`ws-${randomUUID()}`), null)).toBeNull();
    });
  });
});
