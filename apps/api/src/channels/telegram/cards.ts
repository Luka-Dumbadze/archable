// apps/api/src/channels/telegram/cards.ts: edits to change cards already sent by @ArchableBot (plan §7.3, §7.6;
// v3 §4.2, §4.3). DEV-2's governance decides *when* (a push supersedes the head; settle() goes live) and passes
// the cards' chat and message ids from the approvals rows; this module only rewrites them in Telegram.
// Owner-facing text: no Git words, money in GEL.
import { GrammyError, InlineKeyboard, type Api } from 'grammy';

export interface CardRef { chatId: number; messageId: number }
type Editor = Pick<Api, 'editMessageText'>;

export interface CardEditDeps {
  api: Editor;                                                   // @ArchableBot's Api
  sleep?(ms: number): Promise<void>;
  log?(event: string, data: Record<string, unknown>): void;
}

const NO_BUTTONS = { inline_keyboard: [] as never[] };
const UNDO_REF = /^[A-Za-z0-9_-]{22}$/;

export const cardText = {
  superseded: (title: string) => `This change was updated: ${title}.\n\nI'll send you the new version to approve.`,
  live: (osName: string, title: string) => `Live in ${osName}: ${title}.\n\nYou can undo this for 24 hours.`,
  undone: (osName: string, title: string) => `Undone: ${title}.\n\n${osName} is back to the previous version.`,
};

export function createCardEditor(d: CardEditDeps) {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = d.log ?? ((event: string, data: Record<string, unknown>) => console.log(JSON.stringify({ event, ...data })));

  // One card. A card the owner deleted, or one already showing this text, is fine; a 429 waits once (≤ 5 s).
  async function edit(card: CardRef, text: string, markup: { inline_keyboard: unknown[] }): Promise<boolean> {
    const call = () => d.api.editMessageText(card.chatId, card.messageId, text, { reply_markup: markup as never });
    try {
      await call();
      return true;
    } catch (e) {
      if (e instanceof GrammyError && e.error_code === 429) {
        await sleep(Math.min(5, e.parameters.retry_after ?? 1) * 1000);
        try { await call(); return true; } catch (again) { e = again; }
      }
      if (e instanceof GrammyError && /message is not modified/i.test(e.description)) return true;
      log('telegram.card_edit_failed', { chat: card.chatId, message: card.messageId,
        code: e instanceof GrammyError ? e.error_code : null, error: e instanceof GrammyError ? e.description : String(e) });
      return false;
    }
  }
  const all = async (cards: CardRef[], text: string, markup: { inline_keyboard: unknown[] }) =>
    (await Promise.all(cards.map((c) => edit(c, text, markup)))).filter(Boolean).length;

  return {
    /** A new push voided the approvals: every open card loses its buttons. Returns how many cards were edited. */
    supersede: (cards: CardRef[], title: string) => all(cards, cardText.superseded(title), NO_BUTTONS),

    /** settle() flipped the epoch: the card says Live and offers Undo (ud:<ref>, resolved by governance). */
    live: (cards: CardRef[], osName: string, title: string, undoRef: string) => {
      if (!UNDO_REF.test(undoRef)) throw new Error('undoRef must be a 22-char token');
      return all(cards, cardText.live(osName, title), new InlineKeyboard().text('Undo', `ud:${undoRef}`));
    },

    /** After a successful Undo, or when its window closed: the button goes away. */
    undone: (cards: CardRef[], osName: string, title: string) => all(cards, cardText.undone(osName, title), NO_BUTTONS),
  };
}

export type CardEditor = ReturnType<typeof createCardEditor>;
