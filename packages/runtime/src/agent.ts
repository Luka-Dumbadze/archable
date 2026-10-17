// packages/runtime/src/agent.ts: which agent answers a channel, its system prompt, and the holding reply.
// The persona is wording only (T1); facts come from tools. The money rule matters: tools return integer tetri.
import type { Bundle } from '@archable/compiler';
import type { TurnContext } from './context';
import type { Route } from './decisions';
import type { Inbound } from './types';

const CHANNEL_KIND: Record<Inbound['channel'], string> = { telegram: 'telegram_bot', telegram_business: 'telegram_business', web: 'web' };

export class NoAgent extends Error {
  constructor(channel: string) { super(`no agent serves the ${channel} channel`); this.name = 'NoAgent'; }
}

/** The agent of the app that lists a channel of the inbound's kind (apps.*.channels → channels.*.kind). */
export function agentFor(bundle: Bundle, inbound: Pick<Inbound, 'channel'>): string {
  const kind = CHANNEL_KIND[inbound.channel];
  for (const app of Object.values(bundle.apps)) {
    if (app.agent && app.channels.some((c) => bundle.channels[c]?.kind === kind)) return app.agent;
  }
  throw new NoAgent(inbound.channel);
}

export function systemPrompt(bundle: Bundle, agentId: string, route: Route | null, ctx: TurnContext, now = new Date()): string {
  const a = bundle.agents[agentId]!;
  const m = bundle.metadata;
  const customer = ctx.customer
    ? `Known customer: ${JSON.stringify(Object.fromEntries(Object.entries(ctx.customer.attrs).filter(([k]) => ['name', 'age_verified', 'segment'].includes(k))))}.`
    : 'The customer is not identified yet.';
  return [
    a.persona.replace(/^<!--[\s\S]*?-->\s*/, '').trim(),
    '',
    `Business: ${m.name} (${m.os_name}). Time zone ${m.timezone}; now ${now.toISOString()}.`,
    `Money in tool inputs and results is an integer number of minor units (100 = 1 ${m.currency}). Always state amounts in ${m.currency} with two decimals: 3500 is 35.00 ${m.currency}.`,
    'Only state prices, stock, delivery times and policies that a tool returned in this conversation. Never promise a discount, refund, gift or delivery time a tool did not grant.',
    'If a tool call is denied, say plainly what is not possible, or hand the conversation to staff.',
    customer,
    route ? `The message most likely means: ${route.intent}${route.confidence !== null ? ` (p=${route.confidence.toFixed(2)})` : ''}.` : '',
    // Pre-send checks are calibrated on Mkhedruli; on translit they don't separate true from false replies
    // (evals/calibration/results/2026-10-18-jev-1.13.0.txt), so Georgian is always written in Mkhedruli.
    'Answer in the customer’s language. Write Georgian only in Mkhedruli script (ქართული), never in Latin letters, '
      + 'also when the customer writes Georgian in Latin letters. Keep it short.',
  ].filter(Boolean).join('\n');
}

// What the customer gets when a draft can't be sent (I7). Not in the spec yet; fixed per language.
const HOLDING: Record<string, string> = {
  ka: 'ერთი წუთით — ჩვენი გუნდის წევრი მალე გიპასუხებთ.',
  en: 'One moment, please. A member of our team will reply shortly.',
  ru: 'Одну минуту, пожалуйста. Скоро вам ответит наш сотрудник.',
};
export const holdingReply = (locale: string) => HOLDING[locale] ?? HOLDING.en!;
