// policies/orders.cedar: agent→tool permits are generated from agents.*.tools; these files only forbid.

@id("order.discount_cap")
forbid (principal is Agent, action == Action::"order.create", resource)
when { context.input.discount_pct > 10 };

@id("order.large_needs_staff")
forbid (principal is Agent, action == Action::"order.create", resource)
when { context.quote.total > 50000 }                 // 500.00 GEL, in tetri
unless { context.approvals.contains("staff") };
