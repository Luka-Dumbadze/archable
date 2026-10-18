// scripts/onboard-chat.ts: onboarding by conversation (v3 §2.5), through @ArchableBot. The owner describes the business
// in one message; Archable asks at most two clarifying questions (only answers that change money: the discount cap and
// the order total that needs a person), then builds the business while the owner watches the steps in the chat:
// data model, policies, catalog, compile, database, GitHub repository with governance, live.
//   OWNER_TG=<id> WEBHOOK_URL=… WEBHOOK_SECRET=… ARCHABLE_BOT_TOKEN=… pnpm tsx scripts/onboard-chat.ts
// While it runs, the bot's webhook is removed (Telegram allows one receiver); it is restored when the business is live.
// The structure comes from the retail archetype (fixtures/elektro); the business, its categories and its catalog are
// written by the model from the owner's words.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { generateText, Output } from 'ai';
import YAML from 'yaml';
import { z } from 'zod';
import { compile } from '@archable/compiler';
import { createLanguageModels } from '../apps/api/src/turn-wiring';

const token = process.env.ARCHABLE_BOT_TOKEN!, owner = Number(process.env.OWNER_TG);
const webhook = { url: process.env.WEBHOOK_URL!, secret: process.env.WEBHOOK_SECRET! };
if (!token || !owner || !webhook.url || !webhook.secret) throw new Error('set ARCHABLE_BOT_TOKEN, OWNER_TG, WEBHOOK_URL, WEBHOOK_SECRET');
// DRY_DESCRIPTION: a rehearsal without Telegram, the database or GitHub: messages go to the console, the answers are
// 10% and 500 GEL, and the build stops after compiling.
const dry = process.env.DRY_DESCRIPTION;
const dryAnswers = ['10%', '500 GEL'];
const tg = async <T = unknown>(method: string, body: object = {}): Promise<T> => {
  if (dry) {
    const b = body as { text?: string };
    if (b.text) console.log(`[bot] ${b.text}\n`);
    return { message_id: 1 } as T;
  }
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await r.json()) as { ok: boolean; result: T; description?: string };
  if (!j.ok) throw new Error(`${method}: ${j.description}`);
  return j.result;
};
const say = (text: string, extra: object = {}) => tg<{ message_id: number }>('sendMessage', { chat_id: owner, text, ...extra });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const model = createLanguageModels()('openai/gpt-6-luna');

let offset = 0;
let dryTurn = 0;
async function nextMessage(): Promise<string> {
  if (dry) { const m = dryTurn === 0 ? dry : dryAnswers[dryTurn - 1] ?? ''; dryTurn++; console.log(`[owner] ${m}\n`); return m; }
  for (;;) {
    // A network blip while waiting for the owner is retried, not fatal.
    const ups = await tg<{ update_id: number; message?: { chat: { id: number }; text?: string } }[]>('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] })
      .catch(async () => { await new Promise((r) => setTimeout(r, 3000)); return []; });
    for (const u of ups) {
      offset = u.update_id + 1;
      if (u.message?.chat.id === owner && u.message.text) return u.message.text.trim();
    }
  }
}

// A status message the owner watches fill in, step by step.
async function progress(title: string) {
  const lines: string[] = [];
  const m = await say(`${title}\n…`);
  const render = () => tg('editMessageText', { chat_id: owner, message_id: m.message_id, text: `${title}\n\n${lines.join('\n')}` }).catch(() => {});
  return {
    async step(text: string, run: () => Promise<string | void> = async () => {}) {
      lines.push(`⏳ ${text}`); await render();
      let detail: string | void;
      try { detail = await run(); } catch (e) {
        lines[lines.length - 1] = `⚠️ ${text} — stopped`; await render();
        await say('Something went wrong while building. Nothing was half-created that you need to clean up; send me your description again to retry.');
        throw e;
      }
      lines[lines.length - 1] = `✅ ${text}${detail ? ` — ${detail}` : ''}`; await render();
      await sleep(500);
    },
  };
}

const Profile = z.object({
  business_name: z.string().describe('the shop\'s name, as the owner would write it in Latin letters, e.g. "Elektro Tbilisi"'),
  short_name: z.string().describe('one word for the OS name, e.g. "Elektro"'),
  kind: z.string().describe('what the business is, in English, e.g. "an electronics shop"'),
  city: z.string().describe('the city, in English; Tbilisi if not said'),
  categories: z.array(z.object({ id: z.string().describe('snake_case, a-z only'), en: z.string(), ka: z.string().describe('Georgian, Mkhedruli') })).min(3).max(7),
  discount_max_pct: z.number().nullable().describe('the biggest discount staff may give, if the owner said it; else null'),
  large_order_gel: z.number().nullable().describe('the order total above which a person must confirm, if the owner said it; else null'),
  products: z.array(z.object({ label: z.string(), brand: z.string(), category: z.string().describe('one of the category ids'),
    price_gel: z.number(), warranty_months: z.number(), stock: z.number() })).min(6).max(8).describe('a realistic starting catalog for this shop in Georgia, prices in GEL'),
});

const ROOT = 'fixtures/elektro';
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const env = { ...process.env };
const run = (args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

await tg('deleteWebhook', { drop_pending_updates: true });
console.log('webhook removed; waiting for the owner in Telegram…');
try {
  let first = await nextMessage();
  while (first.startsWith('/')) {
    await say('Hi! I\'m Archable. Tell me about your business in a sentence or two: what you sell and where. I\'ll build its operating system for you.');
    first = await nextMessage();
  }
  await tg('sendChatAction', { chat_id: owner, action: 'typing' });
  const { output } = await generateText({ model, maxRetries: 1, output: Output.object({ schema: Profile }),
    system: 'You set up a small business on Archable from the owner\'s description. Fill the profile; invent only what the owner left out and a shop like this would plainly have.',
    prompt: first });
  const p = Profile.parse(output);
  const cats = p.categories.map((c) => ({ ...c, id: c.id.toLowerCase().replace(/[^a-z_]/g, '_').replace(/^_+|_+$/g, '') || 'other' }));
  await say(`Got it: ${p.business_name}, ${p.kind} in ${p.city}.\nYou sell ${cats.map((c) => c.en).join(', ')}.`);

  // At most two questions, and only the ones that change money (v3 §2.5).
  let discount = p.discount_max_pct, large = p.large_order_gel;
  if (discount === null) {
    await say('Question 1 of 2: what is the biggest discount my agent may give a customer without asking you? (for example 10%)');
    discount = Number((await nextMessage()).match(/\d+(\.\d+)?/)?.[0] ?? 10);
  }
  if (large === null) {
    await say(`Question ${p.discount_max_pct === null ? 2 : 1} of ${p.discount_max_pct === null ? 2 : 1}: above what order total should a person confirm before it ships? (for example 300 GEL)`);
    large = Number((await nextMessage()).match(/\d+(\.\d+)?/)?.[0] ?? 300);
  }
  discount = Math.max(0, Math.min(90, Math.round(discount))); large = Math.max(1, Math.round(large));

  const base = (p.short_name || p.business_name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'shop';
  // The first name whose repository doesn't exist yet (a repo the App made can't be deleted by it).
  const repoExists = async (s: string) => (await fetch(`https://api.github.com/repos/archable-tenants/${s}`)).status === 200;
  let slug = base;
  for (const s of [base, `${base}-ge`, `${base}-tbilisi`, `${base}-shop`, `${base}-store`, `${base}-georgia`, `${base}-${Date.now() % 1000}`]) { slug = s; if (!(await repoExists(s))) break; }
  const os = `${p.short_name} OS`;
  const files: Record<string, string> = {};
  const pr = await progress(`Building ${os} for ${p.business_name}`);

  await pr.step('Designing the data model', async () => {
    for (const f of walk(ROOT)) files[relative(ROOT, f).split(sep).join('/')] = readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
    let s = files['enterprise.spec.yaml']!;
    s = s.replace(/^# enterprise\.spec\.yaml:.*$/m, `# enterprise.spec.yaml: ${os}, ${p.kind} in ${p.city} (onboarded by conversation)`)
      .replace(/  id: elektro(\s+#.*)?\n/, `  id: ${slug.replace(/-/g, '_')}\n`)   // spec ids: [a-z_][a-z0-9_]*; the slug keeps its hyphen.replace('  name: Elektro Tbilisi\n', `  name: ${p.business_name}\n`).replace('  os_name: Elektro OS', `  os_name: ${os}`)
      .replace('values: [phones, laptops, tvs, audio, appliances, accessories]', `values: [${cats.map((c) => c.id).join(', ')}]`)
      .replace(/        value_labels:\n(?:          [a-z_]+: \{[^\n]*\}\n)+/, `        value_labels:\n${cats.map((c) => `          ${c.id}: { en: ${JSON.stringify(c.en)}, ka: ${JSON.stringify(c.ka)} }`).join('\n')}\n`)
      .replace(/elektro-courier/g, `${slug}-courier`).replace(/vault:elektro\//g, `vault:${slug}/`).replace('https://elektro.ge', `https://${slug}.ge`);
    files['enterprise.spec.yaml'] = s;
    files['personas/tech_advisor.md'] = files['personas/tech_advisor.md']!.replace('Elektro Tbilisi, an electronics shop in Tbilisi', `${p.business_name}, ${p.kind} in ${p.city}`);
    return `product, customer, order, delivery, courier · ${cats.length} categories`;
  });
  await pr.step('Writing the rules the AI can\'t break', async () => {
    files['policies/orders.cedar'] = files['policies/orders.cedar']!
      .replace(/context\.input\.discount_pct > \d+/, `context.input.discount_pct > ${discount}`)
      .replace(/context\.quote\.total > \d+ \}\s*\/\/[^\n]*/, `context.quote.total > ${large * 100} }                 // ${large}.00 GEL, in tetri`);
    return `max discount ${discount}% · orders over ${large} GEL need a person · replies only with evidence`;
  });
  await pr.step('Stocking the catalog', async () => {
    const valid = new Set(cats.map((c) => c.id));
    const items = p.products.map((x, i) => ({
      sku: `${x.brand.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) || 'SKU'}-${String(i + 1).padStart(3, '0')}`,
      label: x.label, category: valid.has(x.category) ? x.category : cats[0]!.id, brand: x.brand,
      warranty_months: Math.max(0, Math.min(60, Math.round(x.warranty_months))), price: Math.round(x.price_gel * 100), stock: Math.max(0, Math.round(x.stock)),
    }));
    files['seed/products.json'] = JSON.stringify(items, null, 2) + '\n';
    return `${items.length} products, from ${Math.min(...items.map((i) => i.price)) / 100} to ${Math.max(...items.map((i) => i.price)) / 100} GEL`;
  });
  let compiled!: ReturnType<typeof compile>;
  await pr.step('Compiling the backend', async () => {
    const t0 = performance.now();
    compiled = compile({ files }, YAML.parse(files['archable.lock']!));
    const b = compiled.bundle;
    for (const [path, text] of Object.entries(files)) { const to = join('fixtures', slug, path); mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, text); }
    return `${Object.keys(b.tools).length} tools · 2 agents · ${Object.keys(b.policies.byId).length} policies · ${b.graph.nodes.length}-node impact graph · ${Math.round(performance.now() - t0)} ms`;
  });
  if (dry) { console.log(JSON.stringify({ dry: true, slug, digest: compiled.digest, discount, large })); process.exit(0); }
  await pr.step('Creating the database', async () => {
    const out = run(['scripts/onboard.ts', '--slug', slug]);
    return (out.match(/epoch \d+/)?.[0] ?? 'live').replace('epoch', 'live at epoch');
  });
  await pr.step('Creating the GitHub repository with governance', async () => {
    run(['scripts/provision-tenant-repo.ts', '--tenant', slug]);
    return `archable-tenants/${slug} · ruleset archable-governance`;
  });
  await say(`${os} is live. 🎉\n\nYour customers will talk to the Tech Advisor on Telegram. Couriers are booked by the Dispatch Node. Every change you ask me for is drafted, tested and sent to you to approve.\n\nTo open the shop to customers: create a bot with @BotFather and paste its token here.\nTell me what should work differently, any time.`,
    { reply_markup: { inline_keyboard: [[{ text: 'Open the code (GitHub)', url: `https://github.com/archable-tenants/${slug}` }]] } });
  console.log(JSON.stringify({ slug, digest: compiled.digest, discount, large }));
} finally {
  // Confirm what was read here, or Telegram hands the owner's last answer to the webhook as a new request.
  if (!dry) await tg('getUpdates', { offset, timeout: 0 });
  await tg('setWebhook', { url: webhook.url, secret_token: webhook.secret });
  console.log('webhook restored');
}
