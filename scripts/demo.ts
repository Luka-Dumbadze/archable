// scripts/demo.ts: the whole demo from zero, in one command, as often as you like.
//   node --env-file=.env.vercel --import tsx scripts/demo.ts --owner <telegram id> [--clear-chat]
// 1. Reset: deletes the business the previous run created (only those; their names are kept in the OS temp folder).
//    --clear-chat also deletes the last messages of the owner's chat with @ArchableBot (Telegram allows 48 h back).
// 2. Starts the API locally (:8787) and the conversational onboarding (scripts/onboard-chat.ts): the owner sends
//    /start to @ArchableBot and watches the business being built.
// 3. Once the business is live, @ArchableBot and the shop's customer bot (when the owner pastes its token) are relayed
//    to the local API by long polling, and the queue is drained every minute, as Vercel Cron does. Locally a draft has
//    no 60 s function limit (Vercel Hobby), so Draft it runs to the owner's card.
// Ctrl+C: both bots go back to their Vercel webhooks and the API stops. If the window was closed instead,
//   node --env-file=.env.vercel --import tsx scripts/demo.ts --restore      puts @ArchableBot back on Vercel.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { controlDb, runtimeDb, withTenant } from '../apps/api/src/db';

const { values } = parseArgs({ options: { owner: { type: 'string' }, 'clear-chat': { type: 'boolean' }, restore: { type: 'boolean' } } });
const OWNER = Number(values.owner ?? process.env.DEMO_OWNER_TG);
const BOT = process.env.ARCHABLE_BOT_TOKEN, SECRET = process.env.ARCHABLE_BOT_WEBHOOK_SECRET, CRON = process.env.CRON_SECRET;
if (!BOT || !SECRET) throw new Error('needs ARCHABLE_BOT_TOKEN and ARCHABLE_BOT_WEBHOOK_SECRET (node --env-file=.env.vercel)');
const VERCEL = process.env.DEMO_VERCEL_ORIGIN ?? 'https://archable-luka-dumbadze-s-projects.vercel.app';
const LOCAL = 'http://localhost:8787';
const UPDATES = ['message', 'callback_query', 'business_connection', 'business_message', 'edited_business_message', 'deleted_business_messages'];
if (values.restore) {
  const r = await fetch(`https://api.telegram.org/bot${BOT}/setWebhook`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `${VERCEL}/v1/webhooks/telegram/archable`, secret_token: SECRET, allowed_updates: UPDATES }) });
  console.log(`[demo] @ArchableBot back on Vercel: ${(await r.json() as { ok: boolean }).ok}`);
  process.exit(0);
}
if (!Number.isSafeInteger(OWNER)) throw new Error('needs --owner <telegram id>');
const DIR = join(tmpdir(), 'archable-demo');
mkdirSync(DIR, { recursive: true });
const STATE = join(DIR, 'state.json');
const say = (s: string) => console.log(`\x1b[36m[demo]\x1b[0m ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tenantIdOf = (slug: string) => {
  const h = createHash('sha256').update(`archable:tenant:${slug}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
// Bot API with retries: this demo often runs on Wi-Fi, where a request now and then fails.
async function tg<T = unknown>(token: string, method: string, body: object = {}): Promise<{ ok: boolean; result?: T; description?: string }> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return await r.json() as { ok: boolean; result?: T };
    } catch (e) { if (i >= 20) throw e; await sleep(3000); }
  }
}

let stopping = false;
let api: ChildProcess | null = null;
let onboarding: ChildProcess | null = null;
let shop: { token: string; hook: string; secret: string } | null = null;
let botTakenOver = false;

async function restore() {
  if (stopping) return;
  stopping = true;
  say('stopping: bots back to Vercel…');
  onboarding?.kill();
  if (botTakenOver) await tg(BOT!, 'setWebhook', { url: `${VERCEL}/v1/webhooks/telegram/archable`, secret_token: SECRET, allowed_updates: UPDATES }).catch(() => {});
  if (shop) await tg(shop.token, 'setWebhook', { url: `${VERCEL}/v1/webhooks/telegram/b/${shop.hook}`, secret_token: shop.secret, allowed_updates: ['message', 'edited_message', 'callback_query'] }).catch(() => {});
  api?.kill();
  await controlDb.end({ timeout: 2 }).catch(() => {});
  await runtimeDb.end({ timeout: 2 }).catch(() => {});
  say('done.');
  process.exit(0);
}
process.on('SIGINT', restore);
process.on('SIGTERM', restore);

// ── 1. Reset ──
const state: { slugs: string[] } = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { slugs: [] };
for (const slug of state.slugs) {
  if (slug === 'marani') continue;                                   // never the reference tenant
  const id = tenantIdOf(slug);
  const gone = await withTenant(controlDb, id, async (tx) => {
    await tx`delete from public.conversations where tenant_id = ${id}`;      // messages → chapters, before the tenant cascade
    await tx`delete from public.chapters where tenant_id = ${id}`;
    return tx`delete from public.tenants where id = ${id} returning slug`;
  });
  say(gone.length ? `deleted the previous demo business ${slug}` : `previous demo business ${slug} was already gone`);
}
writeFileSync(STATE, JSON.stringify({ slugs: [] }));
const others = await controlDb<{ slug: string }[]>`select slug from private.owner_tenants(${OWNER})`;
if (others.length) say(`⚠️  this owner still owns: ${others.map((o) => o.slug).join(', ')}. Pasting a bot token works only with one business; remove the others first.`);

if (values['clear-chat']) {
  const probe = await tg<{ message_id: number }>(BOT, 'sendMessage', { chat_id: OWNER, text: '…' });
  const last = probe.result?.message_id;
  if (last) {
    for (let to = last; to > Math.max(0, last - 500); to -= 100) {
      const ids = Array.from({ length: 100 }, (_, k) => to - k).filter((n) => n > 0);
      await tg(BOT, 'deleteMessages', { chat_id: OWNER, message_ids: ids }).catch(() => {});
    }
    say('cleared the chat with @ArchableBot');
  }
}

// ── 2. The API, then onboarding ──
if (await fetch(`${LOCAL}/v1/manifest`).then(() => true, () => false)) throw new Error('something already listens on :8787; stop it first');
const apiLog = createWriteStream(join(DIR, 'api.log'));
api = spawn(process.execPath, ['--import', 'tsx', 'apps/api/src/dev.ts'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
api.stdout!.pipe(apiLog); api.stderr!.pipe(apiLog);
api.stdout!.on('data', (b: Buffer) => {                              // the Architect's steps, for whoever runs the demo
  for (const line of b.toString().split('\n')) {
    const m = line.match(/"event":"(architect\.[a-z_]+|queue\.job(?:_failed|_retry)?)"/);
    if (m) say(`  ${m[1]}${line.match(/"outcome":"([a-z_]+)"/)?.[1] ? ` → ${line.match(/"outcome":"([a-z_]+)"/)![1]}` : ''}`);
  }
});
api.on('exit', (code) => { if (!stopping) { say(`the API stopped (code ${code}); see ${join(DIR, 'api.log')}`); void restore(); } });
for (let i = 0; !(await fetch(`${LOCAL}/v1/manifest`).then(() => true, () => false)); i++) {
  if (i > 60) throw new Error(`the API didn't start; see ${join(DIR, 'api.log')}`);
  await sleep(1000);
}
say(`API on ${LOCAL} (log: ${join(DIR, 'api.log')})`);

const slug = await new Promise<string>((resolve, reject) => {
  onboarding = spawn(process.execPath, ['--import', 'tsx', 'scripts/onboard-chat.ts'], {
    env: { ...process.env, OWNER_TG: String(OWNER), SEED_OWNER_TG_ID: String(OWNER), WEBHOOK_URL: `${VERCEL}/v1/webhooks/telegram/archable`, WEBHOOK_SECRET: SECRET },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let found: string | null = null;
  onboarding.stdout!.on('data', (b: Buffer) => {
    for (const line of b.toString().split('\n').filter(Boolean)) {
      if (line.includes('waiting for the owner')) say('ready: send /start to @ArchableBot');
      const m = line.match(/"slug":"([a-z0-9-]+)"/);
      if (m) { found = m[1]!; writeFileSync(STATE, JSON.stringify({ slugs: [found] })); say(`business ${found} is live`); }
    }
  });
  onboarding.on('exit', (code) => (found ? resolve(found) : reject(new Error(`onboarding stopped (code ${code}) before the business was live`))));
});

// ── 3. Relays and the queue tick ──
async function relay(token: string, url: string, secret: string, allowed?: string[]) {
  let offset = 0;
  while (!stopping) {
    const r = await tg<{ update_id: number }[]>(token, 'getUpdates', { offset, timeout: 25, ...(allowed ? { allowed_updates: allowed } : {}) }).catch(() => ({ ok: false as const }));
    for (const u of (r as { result?: { update_id: number }[] }).result ?? []) {
      offset = u.update_id + 1;
      await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify(u) }).catch(() => {});
    }
  }
}

await tg(BOT, 'deleteWebhook', {});
botTakenOver = true;
void relay(BOT, `${LOCAL}/v1/webhooks/telegram/archable`, SECRET, UPDATES);
say('@ArchableBot now runs on this computer (drafts have no time limit)');

void (async () => {                                                  // the shop's bot, once the owner pastes its token
  const id = tenantIdOf(slug);
  const secret = randomBytes(32).toString('base64url');
  while (!stopping && !shop) {
    shop = await withTenant(controlDb, id, async (tx) => {
      const [c] = await tx<{ hook_id: string; bot_username: string }[]>`
        update public.channel_connections set hook_secret_hash = ${createHash('sha256').update(secret).digest()}
         where tenant_id = ${id} and kind = 'telegram_bot' and status = 'live' returning hook_id, bot_username`;
      if (!c) return null;
      const [t] = await tx<{ k: string }[]>`select private.channel_secret(${`${slug}/tg_bot_token`}) as k`;
      say(`shop bot @${c.bot_username} now runs on this computer`);
      return { token: t!.k, hook: c.hook_id, secret };
    }).catch(() => null);
    if (!shop) await sleep(2000);
  }
  if (!shop) return;
  await tg(shop.token, 'deleteWebhook', { drop_pending_updates: false });   // messages sent meanwhile are still delivered
  await relay(shop.token, `${LOCAL}/v1/webhooks/telegram/b/${shop.hook}`, shop.secret);
})();

void (async () => {
  while (!stopping) {
    await sleep(60_000);
    if (CRON) await fetch(`${LOCAL}/v1/cron/drain`, { headers: { authorization: `Bearer ${CRON}` }, signal: AbortSignal.timeout(2000) }).catch(() => {});
  }
})();
say('demo running. Ctrl+C when you are done.');
