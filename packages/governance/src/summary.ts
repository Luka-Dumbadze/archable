// packages/governance/src/summary.ts: the sentences an owner reads for a change (v3 §4.6, PROGRESS.md Q7).
// Deterministic templates over the typed ops and the bundle's labels: no model writes them. The rationale card's
// "What changes" section and the approval summary (P4.D2.6) render from the same templates, so they can't disagree.
import type { BlastRadius, Bundle, Localized, PolicyBound, Reason } from '@archable/compiler';
import { money } from './rationale';
import type { ChangeSet } from '@archable/schema';
import type { z } from 'zod';
import type { Labels } from './rationale';

type Ops = z.infer<typeof ChangeSet>['ops'];

const pick = (l: Localized | undefined, lang: string) => (l ? l[lang] ?? l.en ?? Object.values(l)[0] : undefined);
const words = (s: string) => s.replace(/_/g, ' ');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** 'field:order.payment' → 'payment', 'tool:delivery.dispatch' → 'delivery dispatch': the fallback when unlabelled. */
const humanize = (id: string) => {
  const bare = id.slice(id.indexOf(':') + 1);
  return words(id.startsWith('field:') ? bare.slice(bare.indexOf('.') + 1) : bare.replace(/\./g, ' '));
};

// Bundles are immutable, and those compiled before Q7 carry no labels: they read as empty.
const NO_LABELS: Bundle['labels'] = { nodes: {}, values: {}, context: {}, inputs: {} };
const labelsOf = (b: Bundle) => (b.labels as Bundle['labels'] | undefined) ?? NO_LABELS;

/** Labels for the rationale card, from the head bundle, falling back to the base (removed nodes keep their words). */
export function labelsFrom(head: Bundle, base: Bundle, lang = 'en'): Labels {
  const bundle = { labels: labelsOf(head) }, prior = { labels: labelsOf(base) };
  const nodeLabel = (id: string) => pick(bundle.labels.nodes[id] ?? prior.labels.nodes[id], lang) ?? humanize(id);
  const fieldOf = (path: string) => bundle.labels.context[path] ?? prior.labels.context[path];
  const tags = new Map([...base.graph.nodes, ...head.graph.nodes].map((n) => [n.id, n.tags]));
  return {
    node: nodeLabel,
    path: (p) => { const f = fieldOf(p); return f ? nodeLabel(f) : words(p.split('.').at(-1)!); },
    value: (p, v) => {
      const f = fieldOf(p);
      const key = f && typeof v === 'string' ? `${f.slice('field:'.length)}.${v}` : null;
      return pick(key ? bundle.labels.values[key] ?? prior.labels.values[key] : undefined, lang) ?? words(String(v));
    },
    isMoney: (p) => { const f = fieldOf(p); return !!f && (tags.get(f) ?? []).includes('money'); },
    currency: head.metadata.currency,
  };
}

/** One sentence per op that changes behavior, in ChangeSet order. Eval cases are counted under "How it was checked". */
export function renderOps(ops: Ops, bundle: Bundle, lang = 'en'): string[] {
  const node = (id: string) => pick(labelsOf(bundle).nodes[id], lang) ?? humanize(id);
  const out: string[] = [];
  for (const op of ops) {
    switch (op.op) {
      case 'add_enum': {
        const m = /^objects\.([a-z_]+)\.fields\.([a-z_]+)/.exec(op.path);
        out.push(m ? `${cap(node(`field:${m[1]}.${m[2]}`))} can now be ${op.label}.` : `Adds ${op.label} as an option.`);
        break;
      }
      case 'add_field': out.push(`${cap(node(`object:${op.object}`))} records a new detail: ${words(op.field)}.`); break;
      case 'add_policy': out.push(op.summary ?? `Adds the rule ${op.id}.`); break;
      case 'edit_persona': {
        const name = pick(bundle.agents[op.agent]?.display_name, lang) ?? words(op.agent);
        out.push(op.summary ?? `Changes how ${name} talks to customers.`);
        break;
      }
      case 'set': out.push(`Sets ${words(op.path.split('.').slice(-2).join(' '))} to ${op.value}${op.expect === null ? '' : ` (was ${op.expect})`}.`); break;
      case 'add_eval': break;
    }
  }
  return out;
}

/** A policy cap in the rationale card's words (rationale.ts, "What limits the risk"). */
export function boundSentence(b: PolicyBound, L: Labels): string {
  const cap = L.isMoney(b.path) ? money(b.max, L.currency) : String(b.max);
  const cond = b.when.length ? ` when ${b.when.map((w) => `${L.path(w.path)} is ${L.value(w.path, w.equals)}`).join(' and ')}` : '';
  const exc = b.hasExceptions ? ', unless an exception in that rule applies' : '';
  return `The ${L.path(b.path)} can't exceed ${cap}${cond}${exc}.`;
}

/**
 * The business terms an agent may state (PROGRESS.md Q10): for each tool it may call, the options of every input that
 * takes an enum field, and the caps of the policies bounding the tool. Rendered from the pinned bundle only, so a
 * draft that states them is grounded, and a draft that invents a rule still isn't.
 */
export function businessTerms(bundle: Bundle, agentId: string, lang = 'en'): string[] {
  const L = labelsFrom(bundle, bundle, lang);
  const inputs = labelsOf(bundle).inputs ?? {};
  const terms: string[] = [];
  const seen = new Set<string>();
  const tools = [...(bundle.agents[agentId]?.tools ?? [])].sort();
  for (const t of tools) {
    const props = (bundle.tools[t]?.input as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    for (const name of Object.keys(props).sort()) {
      const field = inputs[`${t}.${name}`];
      if (!field || seen.has(field)) continue;
      const [obj, f] = field.slice('field:'.length).split('.') as [string, string];
      const values = ((bundle.objects[obj]?.schema as { properties?: Record<string, { enum?: string[] }> }).properties?.[f]?.enum) ?? [];
      if (!values.length) continue;
      seen.add(field);
      const options = values.map((v) => pick(labelsOf(bundle).values[`${obj}.${f}.${v}`], lang) ?? words(v));
      terms.push(`${cap(L.node(field))}: ${options.length > 1 ? `${options.slice(0, -1).join(', ')} or ${options.at(-1)}` : options[0]}.`);
    }
  }
  for (const b of bundle.policies.bounds.filter((x) => tools.includes(x.action))) {
    const s = boundSentence(b, L);
    if (!terms.includes(s)) terms.push(s);
  }
  return terms;
}

/** The shortest witness per rule at the deciding tier: breadth-first order puts it first (v3 §3.5). */
export function witnesses(radius: Pick<BlastRadius, 'why'>): Reason[] {
  const seen = new Set<string>();
  return radius.why.filter((r) => (seen.has(r.rule) ? false : (seen.add(r.rule), true)));
}
