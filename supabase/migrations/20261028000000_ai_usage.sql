-- One row per AI analysis attempt (failures and retries included) to measure
-- what analysis costs per user and month. Only counts are stored: no image,
-- prompt, search query text or result. record_id has no foreign key so the
-- cost of deleted records stays countable.
create table if not exists public.ai_usage (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  record_id uuid not null,
  mode text not null check (mode in ('full','price')),
  outcome text not null check (outcome in ('complete','review','no_resources','error')),
  model text not null,
  gemini_calls integer not null default 0,
  prompt_tokens integer not null default 0,
  output_tokens integer not null default 0,
  tool_prompt_tokens integer not null default 0,
  search_queries integer not null default 0,
  duration_ms integer not null,
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_user_created_idx on public.ai_usage (user_id, created_at desc);

-- Users can read their own usage; only analyze-record (service role) writes it.
alter table public.ai_usage enable row level security;
grant select on public.ai_usage to authenticated;
grant insert on public.ai_usage to service_role;

drop policy if exists "ai_usage_select_own" on public.ai_usage;
create policy "ai_usage_select_own" on public.ai_usage for select to authenticated using ((select auth.uid()) = user_id);
