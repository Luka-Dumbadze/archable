// labels: the words a person reads for graph nodes, enum values and policy context paths (PROGRESS.md Q7).
// Read from the spec's optional `label` / `value_labels` and the agents' display names. A label is copy, not
// behavior: the graph keeps labels out of node hashes and hashes them into one `copy:labels` node (change rule ui.copy).
import { contextRefs } from './graph/blast';
import type { Resolved } from './resolve';

export type Localized = Record<string, string>;

export interface BundleLabels {
  nodes: Record<string, Localized>;                  // 'field:order.payment' → { en: 'payment method' }
  values: Record<string, Localized>;                 // 'order.payment.cod' → { en: 'cash on delivery' }
  context: Record<string, string>;                   // 'context.quote.total' → 'field:order.total'
  inputs: Record<string, string>;                    // 'order.create.payment' → 'field:order.payment' (Q10 business terms)
}

const QUOTE_TOOL = 'order.quote';
const byKey = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

export function labelsOf(r: Resolved): BundleLabels {
  const { spec } = r;
  const nodes: Record<string, Localized> = {};
  const values: Record<string, Localized> = {};
  for (const [id, obj] of Object.entries(spec.objects)) {
    if (obj.label) nodes[`object:${id}`] = obj.label;
    for (const [name, f] of Object.entries(obj.fields)) {
      if (f.label) nodes[`field:${id}.${name}`] = f.label;
      for (const [v, l] of Object.entries(f.value_labels ?? {})) values[`${id}.${name}.${v}`] = l;
    }
  }
  for (const [id, t] of Object.entries(spec.tools)) if (t.label) nodes[`tool:${id}`] = t.label;
  for (const [id, a] of Object.entries(spec.agents)) {
    nodes[`agent:${id}`] = a.display_name;
    nodes[`persona:${id}`] = a.display_name;
  }

  // A policy's context path names the field it reads. context.quote.* is the quote tool's output, which prices the
  // object of its first `<object>.<field>` input (order.lines → order): context.quote.total → field:order.total.
  const quoted = Object.values(spec.tools[QUOTE_TOOL]?.input ?? {})
    .map((e) => /^([a-z_]+)\.[a-z_]+\??$/.exec(e)?.[1]).find((o) => o && spec.objects[o]);
  const context: Record<string, string> = {};
  const policies = [...r.policies].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const p of policies) {
    if (!p.action) continue;
    for (const path of [...p.contextPaths].sort()) {
      if (context[path]) continue;
      const [, head, attr] = path.split('.');
      const node = head === 'quote' && attr && quoted && spec.objects[quoted]!.fields[attr]
        ? `field:${quoted}.${attr}`
        : contextRefs(spec, p.action, path).find((n) => n.startsWith('field:'));
      if (node) context[path] = node;
    }
  }
  // Which field each tool input takes: `payment: order.payment` → field:order.payment.
  const inputs: Record<string, string> = {};
  for (const [id, t] of Object.entries(spec.tools)) {
    for (const [name, expr] of Object.entries(t.input)) {
      const m = /^([a-z_]+)\.([a-z_]+)\??$/.exec(expr);
      if (m && spec.objects[m[1]!]?.fields[m[2]!]) inputs[`${id}.${name}`] = `field:${m[1]}.${m[2]}`;
    }
  }
  return { nodes: byKey(nodes), values: byKey(values), context: byKey(context), inputs: byKey(inputs) };
}
