// apps/api/src/governance-deps.ts: the approval and owner functions of DEV-1's ArchableBotDeps (plan §6.3, §7.3, §7.6,
// §7.7; PROGRESS.md Q9 (2), (3)), on the control plane. Shapes are DEV-1's interface in feat/frontend-ui
// (apps/api/src/channels/telegram/archable-bot.ts), so it can be passed through as is after the merge.
import { desireStore, intake, type IntakeDeps, type Lane } from '@archable/architect';
import type { OwnerButton, OwnerReply, RationaleCard } from '@archable/contracts';
import { newNonce, noCards, renderRationale, settle, undo, type CardEditor } from '@archable/governance';
import type { App } from 'octokit';
import type postgres from 'postgres';
import { withTenant } from './db';

type Sql = postgres.Sql;
interface TapArgs { nonceHash: Buffer; tgUserId: number; chatId: number | null; messageId: number | null; evidence: object }
type Outcome = string;

export interface GovernanceWiring {
  control: Sql;
  app: App | null;                                    // null until the App's key is configured: settle can't merge
  cards?: CardEditor;                                 // DEV-1's card editor (Telegram)
  intake: { jev: IntakeDeps['jev']; lane: Lane };
  log?(event: string, data: Record<string, unknown>): void;
}

const PRESS_PATH = '/v1/owner/press';                 // web: POST with body; Telegram: callback_data = body.ref
const REF_HOURS = 24;

export function createGovernanceDeps(w: GovernanceWiring) {
  const { control } = w;
  const store = desireStore(control);
  const ownerTenants = (tg: number) => control<{ tenant_id: string; slug: string; os_name: string; membership_id: string }[]>`
    select * from private.owner_tenants(${tg})`;
  const mintRef = (tenantId: string, membershipId: string, action: 'draft_desire' | 'decline_desire', payload: object) =>
    withTenant(control, tenantId, async (tx) => {
      const ref = newNonce();
      await tx`insert into private.owner_refs (ref, tenant_id, membership_id, action, payload, expires_at)
               values (${ref}, ${tenantId}, ${membershipId}, ${action}, ${tx.json(payload as never)}, now() + make_interval(hours => ${REF_HOURS}))`;
      return ref;
    });
  const press = (label: string, ref: string): OwnerButton => ({ label, action: 'post', path: PRESS_PATH, body: { ref } });

  return {
    async consume(a: TapArgs & { decision: 'approve' | 'reject' }): Promise<{ outcome: Outcome; change_request_id: string | null }> {
      const [r] = await control<{ outcome: string; change_request_id: string | null }[]>`
        select outcome, change_request_id from public.consume_telegram_approval(${a.nonceHash}, ${a.tgUserId}, ${a.chatId}, ${a.messageId},
          ${a.decision}, ${control.json(a.evidence as never)})`;
      return { outcome: r!.outcome, change_request_id: r!.change_request_id };
    },

    async beginTyped(a: TapArgs & { codeHash: Buffer }): Promise<{ outcome: Outcome; approval_id: string | null }> {
      const [r] = await control<{ outcome: string; approval_id: string | null }[]>`
        select outcome, approval_id from public.begin_typed_confirmation(${a.nonceHash}, ${a.tgUserId}, ${a.chatId}, ${a.messageId}, ${a.codeHash})`;
      return { outcome: r!.outcome, approval_id: r!.approval_id };
    },

    async completeTyped(a: { tgUserId: number; chatId: number; codeHash: Buffer; evidence: object }): Promise<{ outcome: Outcome; change_request_id: string | null }> {
      const [r] = await control<{ outcome: string; change_request_id: string | null }[]>`
        select outcome, change_request_id from public.complete_typed_confirmation(${a.tgUserId}, ${a.chatId}, ${a.codeHash},
          ${control.json(a.evidence as never)})`;
      return { outcome: r!.outcome, change_request_id: r!.change_request_id };
    },

    /** The exact text whose digest is in the approval (plan §7.3): what the typed prompt repeats. */
    async approvalSummary(approvalId: string): Promise<string> {
      const [r] = await control<{ s: string | null }[]>`select private.approval_summary(${approvalId}) as s`;
      return r?.s ?? '';
    },

    async settle(changeRequestId: string): Promise<void> {
      if (!w.app) throw new Error('settle needs the GitHub App (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY)');
      const r = await settle({ control, app: w.app, cards: w.cards ?? noCards, ...(w.log ? { log: w.log } : {}) }, changeRequestId);
      w.log?.('governance.settle', { change_request: changeRequestId, ...r });
    },

    /** rv:c:<change id>: the frozen card of a change, for an owner of its tenant; null otherwise. */
    async rationaleFor(ref: string, tgUserId: number): Promise<string | null> {
      if (!/^[0-9a-f-]{36}$/.test(ref)) return null;
      for (const t of await ownerTenants(tgUserId)) {
        const [cr] = await withTenant(control, t.tenant_id, (tx) => tx<{ rationale: RationaleCard | null }[]>`
          select rationale from public.change_requests where tenant_id = ${t.tenant_id} and id = ${ref}`);
        if (cr?.rationale) return renderRationale(cr.rationale);
      }
      return null;
    },

    /** Owner text → the normalized statement with Draft it / Not this (plan §7.7). */
    async ownerMessage(tgUserId: number, text: string): Promise<OwnerReply> {
      const [t] = await ownerTenants(tgUserId);
      if (!t) return { text: 'This Telegram account doesn’t own a business on Archable yet.', buttons: [] };
      const r = await intake({ ...w.intake, store }, { tenantId: t.tenant_id, membershipId: t.membership_id, text, at: new Date().toISOString() });
      if (r.outcome === 'not_a_change') {
        return { text: `Tell me what should work differently in ${t.os_name}, and I’ll prepare the change for you to approve.`,
                 buttons: [{ label: `Open ${t.os_name}`, action: 'url', url: `https://${t.slug}.archable.run` }] };
      }
      const d = r.desire;
      const [draft, decline] = await Promise.all([
        mintRef(t.tenant_id, t.membership_id, 'draft_desire', { desire: d.id }),
        mintRef(t.tenant_id, t.membership_id, 'decline_desire', { desire: d.id }),
      ]);
      const lead = r.outcome === 'attached' ? `This is like an earlier request (D-${d.number}):` : `I understood (D-${d.number}):`;
      return { text: `${lead}\n“${d.statement}”`, buttons: [press('Draft it', draft), press('Not this', decline)] };
    },

    /** A post button by its ref: single use, the owner it was minted for, within 24 h; null when not (Q9 (2)). */
    async ownerPress(tgUserId: number, ref: string): Promise<OwnerReply | null> {
      const [r] = await control<{ outcome: string; tenant_id: string | null; action: string | null; payload: { desire?: string } | null }[]>`
        select outcome, tenant_id, action, payload from private.take_owner_ref(${ref}, ${tgUserId})`;
      if (!r || r.outcome !== 'ok' || !r.tenant_id || !r.payload?.desire) return null;
      const tenantId = r.tenant_id, desire = r.payload.desire;
      if (r.action === 'decline_desire') {
        await withTenant(control, tenantId, (tx) => tx`update public.desires set status = 'declined', updated_at = now() where tenant_id = ${tenantId} and id = ${desire}`);
        return { text: 'OK, I’ve set it aside.', buttons: [] };
      }
      if (r.action === 'draft_desire') {
        await withTenant(control, tenantId, async (tx) => {
          await tx`update public.desires set status = 'drafting', updated_at = now() where tenant_id = ${tenantId} and id = ${desire} and status = 'open'`;
          await tx`select private.architect_send(${tx.json({ kind: 'draft', tenant_id: tenantId, desire_id: desire })})`;
        });
        return { text: 'Drafting it now. I’ll send you the change to approve once it’s checked.', buttons: [] };
      }
      return null;
    },

    undo: (tgUserId: number, ref: string) => undo(control, tgUserId, ref),
  };
}

export type GovernanceDeps = ReturnType<typeof createGovernanceDeps>;
