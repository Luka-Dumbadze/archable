// policies/messaging.cedar: the send guard. Evidence from the decision heads is bound to the exact draft.
@id("send.requires_grounding")
forbid (principal is Agent, action == Action::"message.send", resource)
unless {
  context.signals.grounded.verdict == "pass" &&
  context.signals.grounded.payload_digest == context.payload_digest &&
  context.signals.commitment.verdict == "pass" &&
  context.signals.commitment.payload_digest == context.payload_digest
};
