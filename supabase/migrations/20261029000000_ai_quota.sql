-- Monthly AI quota per user, counted on the server (docs/concept.md R1).
-- Two kinds: "read" reads names from the photo only (cheap); "research" also
-- searches the web for tracks and prices (about 0.15 USD per run on 2026-10-28).
-- analyze-record consumes one unit right before calling Gemini and skips the
-- call when the month's limit is used up. Months follow Japan time.

alter table public.ai_usage drop constraint if exists ai_usage_mode_check;
alter table public.ai_usage add constraint ai_usage_mode_check check (mode in ('read','full','price'));

create table if not exists public.ai_quota_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  month date not null,
  kind text not null check (kind in ('read','research')),
  used integer not null default 0,
  primary key (user_id, month, kind)
);

-- Per-user limits that differ from the defaults (e.g. the owner's account).
create table if not exists public.ai_quota_overrides (
  user_id uuid primary key references auth.users(id) on delete cascade,
  read_limit integer,
  research_limit integer
);

alter table public.ai_quota_usage enable row level security;
alter table public.ai_quota_overrides enable row level security;
grant select, insert, update on public.ai_quota_usage to service_role;
grant select on public.ai_quota_overrides to service_role;

create or replace function public.ai_quota_month()
returns date
language sql
stable
set search_path = ''
as $$
  select date_trunc('month', now() at time zone 'Asia/Tokyo')::date;
$$;

-- Default limits live here; change them with create or replace.
create or replace function public.ai_quota_limit(p_user uuid, p_kind text)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select case p_kind when 'read' then o.read_limit else o.research_limit end
     from public.ai_quota_overrides o where o.user_id = p_user),
    case p_kind when 'read' then 300 else 20 end
  );
$$;

-- Atomically uses one unit; false when the limit is reached.
create or replace function public.consume_ai_quota(p_user uuid, p_kind text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  quota integer := public.ai_quota_limit(p_user, p_kind);
  consumed boolean;
begin
  if quota <= 0 then
    return false;
  end if;
  insert into public.ai_quota_usage as q (user_id, month, kind, used)
  values (p_user, public.ai_quota_month(), p_kind, 1)
  on conflict (user_id, month, kind) do update
    set used = q.used + 1
    where q.used < quota
  returning true into consumed;
  return coalesce(consumed, false);
end;
$$;

revoke execute on function public.ai_quota_limit(uuid, text) from public, anon, authenticated;
revoke execute on function public.consume_ai_quota(uuid, text) from public, anon, authenticated;
grant execute on function public.ai_quota_limit(uuid, text) to service_role;
grant execute on function public.consume_ai_quota(uuid, text) to service_role;

-- What the app shows: this month's use and limits for the signed-in user.
create or replace function public.my_ai_quota()
returns table (kind text, used integer, quota integer)
language sql
stable
security definer
set search_path = ''
as $$
  select k.kind,
         coalesce((select q.used from public.ai_quota_usage q
                   where q.user_id = (select auth.uid()) and q.month = public.ai_quota_month() and q.kind = k.kind), 0),
         public.ai_quota_limit((select auth.uid()), k.kind)
  from (values ('read'), ('research')) as k(kind)
  where (select auth.uid()) is not null;
$$;

revoke execute on function public.my_ai_quota() from public, anon;
grant execute on function public.my_ai_quota() to authenticated;
