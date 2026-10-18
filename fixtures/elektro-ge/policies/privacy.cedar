// policies/privacy.cedar: order status only for someone who knows both the number and the phone.
// On Telegram the gateway fills `phone` from the customer linked to the chat; on the web the customer types it.
@id("privacy.status_needs_phone")
forbid (principal, action == Action::"delivery.status", resource)
unless { context.order.customer_phone == context.input.phone };

// An age-verified customer's birthdate is not the agent's to change: it is what the age check rests on (Q8).
// The customer may not exist yet (customer.upsert creates it), hence `context has customer`.
@id("customer.keeps_verified_birthdate")
forbid (principal is Agent, action == Action::"customer.upsert", resource)
when { context has customer && context.customer.age_verified && context.input has birthdate };
