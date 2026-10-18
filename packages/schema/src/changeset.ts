// packages/schema/src/changeset.ts: everything the Architect can do to a spec
import { z } from 'zod';

const OUT_OF_REACH = /^(governance|risk|connections|channels|runtime)(\.|$)/;   // humans only (§4.8)
const Path = z.string().regex(/^[a-z_][a-z0-9_.*]*$/)
  .refine((p) => !OUT_OF_REACH.test(p), 'path is outside the Architect’s reach');
const Scalar = z.union([z.string(), z.number(), z.boolean()]);

export const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), path: Path, value: Scalar, expect: Scalar.nullable() }),
  z.object({ op: z.literal('add_enum'), path: Path, value: z.string(), label: z.string() }),
  z.object({ op: z.literal('add_field'), object: z.string(), field: z.string(), type: z.string(), optional: z.boolean() }),
  // summary: the one line the owner reads for this op (PROGRESS.md Q7); the op itself is what is applied.
  z.object({ op: z.literal('add_policy'), file: z.string(), id: z.string(), cedar: z.string(), summary: z.string().max(140).optional() }),
  z.object({ op: z.literal('edit_persona'), agent: z.string(), find: z.string(), replace: z.string(), summary: z.string().max(140).optional() }),
  z.object({ op: z.literal('add_eval'), suite: z.string(), id: z.string(), yaml: z.string() }),
]);

export const ChangeSet = z.object({
  desire: z.string(),                                  // 'D-14'
  base_digest: z.string(),                             // the bundle the ops were written against
  rationale: z.string().max(600),
  ops: z.array(Op).min(1).max(12),
});
