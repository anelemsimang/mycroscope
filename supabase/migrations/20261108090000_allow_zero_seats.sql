-- A paid plan can exist before any seat is purchased. Zero seats means only the
-- account creator stays active until seats are bought.

alter table public.subscriptions drop constraint if exists subscriptions_seats_check;
alter table public.subscriptions add constraint subscriptions_seats_check
  check (seats between 0 and 100000);
