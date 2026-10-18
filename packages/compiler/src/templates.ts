// Template manifests: which tools and objects each app template owns (PROGRESS.md Q4).
// Templates are compiler inputs pinned by major version in archable.lock; a spec's `tools.*.app` overrides
// the owner (plan §1.5). A2A edges and object ownership come from here.

export interface TemplateManifest {
  tools: string[];
  objects: string[];
  moneyParams: string[];                                     // params under apps.<id>.params that carry money
}

export const TEMPLATES: Record<string, TemplateManifest> = {
  'tpl.contact_center@3': {
    tools: ['catalog.search', 'order.quote', 'order.create', 'handoff.staff'],
    objects: ['wine', 'product', 'order'],
    moneyParams: [],
  },
  'tpl.dispatch@2': {
    tools: ['delivery.dispatch', 'delivery.update', 'payout.compute'],
    objects: ['delivery_job', 'courier'],
    moneyParams: ['express.surcharge'],
  },
  'tpl.crm@2': {
    tools: ['customer.upsert'],
    objects: ['customer'],
    moneyParams: [],
  },
};
