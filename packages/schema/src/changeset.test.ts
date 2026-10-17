import { describe, expect, it } from 'vitest';
import { ChangeSet } from './changeset';

const base = { desire: 'D-14', base_digest: 'sha256:00', rationale: 'Allow cash on delivery up to 300 GEL.' };

describe('ChangeSet', () => {
  it('accepts an op inside the Architect’s reach', () => {
    const r = ChangeSet.safeParse({ ...base, ops: [{ op: 'add_enum', path: 'objects.order.fields.payment', value: 'cod', label: 'Cash on delivery' }] });
    expect(r.success).toBe(true);
  });

  it('rejects an op touching governance.*', () => {
    const r = ChangeSet.safeParse({ ...base, ops: [{ op: 'set', path: 'governance.architect.max_open_prs', value: 10, expect: 3 }] });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe('path is outside the Architect’s reach');
  });

  it('rejects more than 12 ops', () => {
    const op = { op: 'set', path: 'apps.quickshipper.params.express.surcharge', value: 1500, expect: 1000 };
    expect(ChangeSet.safeParse({ ...base, ops: Array(13).fill(op) }).success).toBe(false);
  });
});
