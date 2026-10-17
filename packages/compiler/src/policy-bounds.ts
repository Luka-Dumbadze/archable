// packages/compiler/src/policy-bounds.ts: numeric caps read from Cedar forbid policies, for rationale cards.
// Input is Cedar's JSON policy format (cedar-wasm policyToJson), so nothing here parses Cedar text.

export interface PolicyBound {
  policy: string;                                     // @id
  action: string;                                     // 'order.create'
  path: string;                                       // 'context.quote.total'
  max: number;                                        // largest allowed value
  when: { path: string; equals: string | number | boolean }[];   // equality conditions in the same `when`
  hasExceptions: boolean;                             // an `unless` clause can lift the cap
}

type Expr = Record<string, any>;

const attrPath = (e: Expr): string | null =>
  e.Var ? e.Var : e['.'] ? ((p) => (p ? `${p}.${e['.'].attr}` : null))(attrPath(e['.'].left)) : null;

const conjuncts = (e: Expr): Expr[] => (e['&&'] ? [...conjuncts(e['&&'].left), ...conjuncts(e['&&'].right)] : [e]);

export function boundsOf(est: Expr): PolicyBound[] {
  const id: string | undefined = est.annotations?.id;
  if (!id || est.effect !== 'forbid' || est.action?.op !== '==') return [];
  const conditions: Expr[] = est.conditions ?? [];
  const hasExceptions = conditions.some((c) => c.kind === 'unless');
  const out: PolicyBound[] = [];
  for (const c of conditions) {
    if (c.kind !== 'when') continue;
    const parts = conjuncts(c.body);
    const when = parts.flatMap((p) => {
      const eq = p['=='];
      const path = eq && attrPath(eq.left);
      return path && eq.right && 'Value' in eq.right ? [{ path, equals: eq.right.Value }] : [];
    });
    for (const p of parts) {
      const [op, cmp] = p['>'] ? ['>', p['>']] : p['>='] ? ['>=', p['>=']] : [null, null];
      const path = cmp && attrPath(cmp.left);
      const v = cmp?.right?.Value;
      if (!op || !path || typeof v !== 'number') continue;
      out.push({ policy: id, action: est.action.entity.id, path, max: op === '>' ? v : v - 1, when, hasExceptions });
    }
  }
  return out;
}
