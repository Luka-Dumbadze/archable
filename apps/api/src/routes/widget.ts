// apps/api/src/routes/widget.ts: the one-line embed. archable.run/widget.js is rewritten here.
// The loader only draws a launcher and an iframe; the chat itself runs on the tenant's origin, so the host
// page never sees a token, a message or the session secret, and the chat API never trusts a host origin.
import { Hono } from 'hono';
import type { WidgetConfig } from '@archable/contracts';
import { publicCors } from '../http/cors';

export type { WidgetConfig };                   // in contracts since Q3: the chat page reads embed_origins for frame-ancestors

export interface WidgetDeps {
  widgetConfig(slug: string): Promise<WidgetConfig | null>;   // from the active bundle; null if chat is off
}

export const LOADER = String.raw`(() => {
  const s = document.currentScript;
  const slug = s && s.dataset.tenant;
  if (!slug || !/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(slug) || slug.includes('--') || window.__archableChat) return;
  window.__archableChat = true;
  const origin = 'https://' + slug + '.archable.run';
  const lang = (document.documentElement.lang || navigator.language || 'en').slice(0, 2);
  const frame = document.createElement('iframe');
  frame.src = origin + '/chat?embed=1&lang=' + encodeURIComponent(lang);
  frame.title = 'Chat';
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');
  frame.style.cssText = 'position:fixed;bottom:88px;right:16px;width:min(380px,calc(100vw - 32px));' +
    'height:min(600px,calc(100vh - 120px));border:0;border-radius:16px;box-shadow:0 8px 32px rgba(0,0,0,.2);' +
    'display:none;z-index:2147483646;background:#fff';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Open chat');
  btn.style.cssText = 'position:fixed;bottom:16px;right:16px;height:56px;min-width:56px;padding:0 20px;border:0;' +
    'border-radius:28px;color:#fff;font:600 15px system-ui,sans-serif;cursor:pointer;z-index:2147483647;background:#333';
  btn.textContent = 'Chat';
  const toggle = (open) => {
    frame.style.display = open ? 'block' : 'none';
    btn.setAttribute('aria-expanded', String(open));
    if (open) frame.contentWindow && frame.contentWindow.postMessage({ type: 'archable:opened' }, origin);
  };
  btn.addEventListener('click', () => toggle(frame.style.display === 'none'));
  window.addEventListener('message', (e) => {
    if (e.origin !== origin || e.source !== frame.contentWindow || !e.data) return;
    if (e.data.type === 'archable:close') toggle(false);
  });
  fetch('https://api.archable.run/v1/widget/config/' + slug)
    .then((r) => (r.ok ? r.json() : null))
    .then((c) => {
      if (!c) return;                                          // chat is off: show nothing
      btn.style.background = c.brand;
      btn.textContent = c.launcher.label[lang] || c.launcher.label.en || 'Chat';
      if (c.launcher.position === 'left') { btn.style.right = frame.style.right = 'auto'; btn.style.left = frame.style.left = '16px'; }
      document.body.append(frame, btn);
    })
    .catch(() => {});
})();
`;

export function widgetRoutes(d: WidgetDeps) {
  const app = new Hono();
  app.get('/v1/widget.js', (c) => {
    c.header('Content-Type', 'text/javascript; charset=utf-8');
    c.header('Cache-Control', 'public, max-age=300, s-maxage=3600');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(LOADER);
  });
  app.use('/v1/widget/config/*', publicCors());
  app.get('/v1/widget/config/:slug', async (c) => {
    const cfg = await d.widgetConfig(c.req.param('slug'));
    if (!cfg) return c.json({ error: 'chat_unavailable' }, 404);
    c.header('Cache-Control', 'public, max-age=60, s-maxage=60');
    return c.json(cfg);
  });
  return app;
}
