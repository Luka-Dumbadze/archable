// scripts/smoke-deploy.mjs: one pass over a deployed API, every route group, PASS / FAIL with the likely cause.
//   OWNER_TOKEN=… node scripts/smoke-deploy.mjs https://archable-luka-dumbadze-s-projects.vercel.app [--turn]
// Plain Node (no dependencies). Read-only except --turn, which sends one console turn ("Do you have a Saperavi?")
// into the owner's try-thread 'smoke'. Never prints the token.
const base = (process.argv[2] ?? '').replace(/\/$/, '');
const token = process.env.OWNER_TOKEN;
const withTurn = process.argv.includes('--turn');
if (!/^https:\/\//.test(base)) { console.error('usage: OWNER_TOKEN=… node scripts/smoke-deploy.mjs https://<deployment> [--turn]'); process.exit(2); }
const ORIGIN = 'https://marani.archable.run';
const results = [];
const check = (name, ok, detail, hint) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ${detail}${ok || !hint ? '' : `\n      → ${hint}`}`); };
const req = async (path, o = {}) => {
  const headers = { origin: ORIGIN, ...(o.auth && token ? { authorization: `Bearer ${token}` } : {}), ...(o.body ? { 'content-type': 'application/json' } : {}), ...(o.headers ?? {}) };
  try {
    const r = await fetch(base + path, { method: o.method ?? (o.body ? 'POST' : 'GET'), headers, ...(o.body ? { body: JSON.stringify(o.body) } : {}), redirect: 'manual' });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text, headers: r.headers };
  } catch (e) { return { status: 0, json: null, text: String(e), headers: new Headers() }; }
};
const DB = 'the database variables (DATABASE_URL_RUNTIME, DATABASE_URL_CONTROL) are missing or wrong for this deployment';

const h = await req('/healthz');
check('GET /healthz', h.status === 200 && h.json?.ok === true, `${h.status}`,
  h.status === 302 || h.status === 401 ? 'Vercel Deployment Protection is on' : 'the function does not start: see the deployment log (ERR_MODULE_NOT_FOUND → apps/api dependencies)');

const m = await req('/v1/manifest');
check('GET /v1/manifest (marani)', m.status === 200 && /^sha256:/.test(m.json?.digest ?? ''), `${m.status} ${m.json?.digest?.slice(0, 15) ?? m.text.slice(0, 60)}`, m.status === 500 ? DB : 'is Marani seeded and live?');
const digest = m.json?.digest;

const pre = await req('/v1/manifest', { method: 'OPTIONS', headers: { 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
check('CORS preflight (tenant origin)', pre.status === 204 && pre.headers.get('access-control-allow-origin') === ORIGIN, `${pre.status} allow-origin ${pre.headers.get('access-control-allow-origin')}`, 'tenantCors (DEV-1, channels/mount.ts)');

if (!token) console.log('SKIP  routes that need OWNER_TOKEN (set it to check them)');
else {
  const ui = await req(`/v1/bundles/${digest}/ui`, { auth: true });
  check('GET /v1/bundles/:digest/ui', ui.status === 200 && Array.isArray(ui.json?.nav), `${ui.status} ${ui.headers.get('cache-control') ?? ''}`,
    ui.status === 401 ? 'token expired or rejected: mint a new one; else SUPABASE_JWKS_URL / the database variables' : DB);
  const a2a = await req('/v1/dev/a2a', { auth: true });
  check('GET /v1/dev/a2a', a2a.status === 200 && Array.isArray(a2a.json?.edges), `${a2a.status} ${a2a.json?.edges ? `${a2a.json.edges.length} edges` : a2a.text.slice(0, 60)}`,
    a2a.status === 403 ? 'token rejected (expired, or not an owner/developer of Marani)' : DB);
  const edge = a2a.json?.edges?.find((e) => e.via === 'delivery.status');
  if (edge) {
    const ed = await req(`/v1/dev/a2a/edges/${encodeURIComponent(edge.id)}`, { auth: true });
    check('GET /v1/dev/a2a/edges/:id', ed.status === 200 && ed.json?.contract?.tool === 'delivery.status', `${ed.status} contract ${ed.json?.contract?.operation_id ?? '-'}`, DB);
  }
  const des = await req('/v1/dev/desires', { auth: true });
  check('GET /v1/dev/desires', des.status === 200 && Array.isArray(des.json), `${des.status} ${Array.isArray(des.json) ? `${des.json.length} desires` : des.text.slice(0, 60)}`, DB);
  const om = await req('/v1/owner/messages', { auth: true, body: { text: 'how many orders did we get this week?' } });
  check('POST /v1/owner/messages', om.status === 200 && typeof om.json?.text === 'string', `${om.status} ${om.json?.text?.slice(0, 50) ?? om.text.slice(0, 60)}`,
    om.status === 404 ? 'Owner Mode is not mounted: set TYPESAFE_API_KEY (and OPENAI_API_KEY), redeploy; is the P5.D2.3 PR merged?' : 'see the log');
  if (withTurn) {
    const t = await req('/v1/turns', { auth: true, body: { text: 'Do you have a Saperavi? How much is it?', thread: 'smoke' } });
    check('POST /v1/turns (one console turn)', t.status === 200 && typeof t.json?.reply === 'string', `${t.status} sent=${t.json?.sent} ${t.json?.reply?.slice(0, 50) ?? t.text.slice(0, 60)}`,
      'OPENAI_API_KEY / TYPESAFE_API_KEY, or the 60 s limit');
  }
}

const cron = await req('/v1/cron/drain');
check('GET /v1/cron/drain (no secret)', cron.status === 401, `${cron.status}`, cron.status === 404 ? 'not mounted: needs GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET and TYPESAFE_API_KEY' : '');
const gh = await req('/v1/webhooks/github', { method: 'POST', body: {} });
check('POST /v1/webhooks/github (unsigned)', gh.status === 401, `${gh.status}`, gh.status === 404 ? 'not mounted: needs the three GITHUB_* variables' : '');
const tg = await req('/v1/webhooks/telegram/archable', { method: 'POST', body: {} });
check('POST /v1/webhooks/telegram/archable', tg.status === 401, `${tg.status} (401: bot configured, refuses a missing secret)`, tg.status === 503 ? 'set ARCHABLE_BOT_TOKEN and ARCHABLE_BOT_WEBHOOK_SECRET' : '');

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
