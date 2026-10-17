// policies/orders.cedar: agent→tool permits are generated from agents.*.tools; these files only forbid.

@id("order.age_gate")
forbid (principal, action == Action::"order.create", resource)
unless { context.customer.age_verified };

@id("order.discount_cap")
forbid (principal is Agent, action == Action::"order.create", resource)
when { context.input.discount_pct > 10 };

@id("order.large_needs_staff")
forbid (principal is Agent, action == Action::"order.create", resource)
when { context.quote.total > 30000 }                 // 300.00 GEL, in tetri
unless { context.approvals.contains("staff") };
