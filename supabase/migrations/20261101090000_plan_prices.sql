-- New monthly prices, still exclusive of VAT. R0, R100, R200, R300.

update public.plans set net_price_cents = 10000 where key = 'work_activity';
update public.plans set net_price_cents = 20000 where key = 'workforce';
update public.plans set net_price_cents = 30000 where key = 'productivity';

notify pgrst, 'reload schema';
