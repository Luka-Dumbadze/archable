// policies/privacy.cedar: order status only for someone who knows both the number and the phone.
// On Telegram the gateway fills `phone` from the customer linked to the chat; on the web the customer types it.
@id("privacy.status_needs_phone")
forbid (principal, action == Action::"delivery.status", resource)
unless { context.order.customer_phone == context.input.phone };
