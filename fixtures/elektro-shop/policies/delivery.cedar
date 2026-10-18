// policies/delivery.cedar
@id("delivery.only_confirmed")
forbid (principal, action == Action::"delivery.dispatch", resource)
unless { context.order.status == "confirmed" };
