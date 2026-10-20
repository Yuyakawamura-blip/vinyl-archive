create table if not exists public.records (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  data jsonb not null default '{}'::jsonb,
  cover_path text,
  ai_status text not null default 'pending' check (ai_status in ('pending','processing','complete','review','error','no_resources')),
  ai_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.records drop constraint if exists records_ai_status_check;
alter table public.records add constraint records_ai_status_check
  check (ai_status in ('pending','processing','complete','review','error','no_resources'));

-- Expose frequently used record fields as real columns so they can be queried,
-- sorted and indexed. The app and the analyze-record Edge Function keep reading
-- and writing the data jsonb; Postgres derives these columns from it, so no
-- client changes are needed. Non-numeric values become NULL instead of failing
-- the write.
alter table public.records
  add column if not exists artist text generated always as (data->>'artist') stored,
  add column if not exists title text generated always as (data->>'title') stored,
  add column if not exists genre text generated always as (data->>'genre') stored,
  add column if not exists catalog_no text generated always as (data->>'catalogNo') stored,
  add column if not exists year integer generated always as (
    case when jsonb_typeof(data->'year') = 'number' then (data->'year')::numeric::integer end
  ) stored,
  add column if not exists market_price bigint generated always as (
    case when jsonb_typeof(data->'marketPrice') = 'number' then (data->'marketPrice')::numeric::bigint end
  ) stored,
  add column if not exists market_price_basis text generated always as (data->>'marketPriceBasis') stored,
  add column if not exists added text generated always as (data->>'added') stored;

-- Downloads list a user's records newest first.
create index if not exists records_user_created_idx on public.records (user_id, created_at desc);
create index if not exists records_user_artist_idx on public.records (user_id, artist);

alter table public.records enable row level security;
grant select, insert, update, delete on public.records to authenticated;
create index if not exists records_user_id_idx on public.records(user_id);

create policy "records_select_own" on public.records for select to authenticated using ((select auth.uid()) = user_id);
create policy "records_insert_own" on public.records for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "records_update_own" on public.records for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "records_delete_own" on public.records for delete to authenticated using ((select auth.uid()) = user_id);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
    and not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'records'
    ) then
    execute 'alter publication supabase_realtime add table public.records';
  end if;
end
$$;

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('record-covers','record-covers',false,10485760,array['image/jpeg','image/png','image/webp','image/heic','image/heif'])
on conflict (id) do nothing;

create policy "covers_select_own" on storage.objects for select to authenticated using (bucket_id='record-covers' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy "covers_insert_own" on storage.objects for insert to authenticated with check (bucket_id='record-covers' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy "covers_update_own" on storage.objects for update to authenticated using (bucket_id='record-covers' and (storage.foldername(name))[1]=(select auth.uid())::text) with check (bucket_id='record-covers' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy "covers_delete_own" on storage.objects for delete to authenticated using (bucket_id='record-covers' and (storage.foldername(name))[1]=(select auth.uid())::text);

-- Run AI analysis on the server. The app only marks a record pending (and may
-- ping analyze-record to start it at once); pg_cron calls analyze-record every
-- minute so pending, failed and stuck records are picked up even when no app is
-- open. Requires two Vault secrets:
--   analyze_worker_url    = https://<project-ref>.supabase.co/functions/v1/analyze-record
--   analyze_worker_secret = same value as the ANALYZE_WORKER_SECRET Edge Function secret
create extension if not exists pg_net;
create extension if not exists pg_cron;

alter table public.records add column if not exists ai_attempts integer not null default 0;

-- analyze-record now works with the service role (it runs without a user
-- session when called by pg_cron); it only reads and updates records.
grant select, update on public.records to service_role;

-- Marking a record pending again (new upload or a retry request) starts a
-- fresh set of attempts.
create or replace function public.reset_ai_attempts()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.ai_status = 'pending' and old.ai_status is distinct from 'pending' then
    new.ai_attempts := 0;
  end if;
  return new;
end;
$$;

drop trigger if exists records_reset_ai_attempts on public.records;
create trigger records_reset_ai_attempts
  before update of ai_status on public.records
  for each row execute function public.reset_ai_attempts();

-- Ready: pending, failed at least 10 minutes ago, or stuck in processing for
-- 15 minutes; at most 3 attempts.
create or replace function public.ai_job_ready(r public.records)
returns boolean
language sql
stable
set search_path = ''
as $$
  select r.cover_path is not null
    and r.ai_attempts < 3
    and (
      r.ai_status = 'pending'
      or (r.ai_status = 'error' and r.updated_at < now() - interval '10 minutes')
      or (r.ai_status = 'processing' and r.updated_at < now() - interval '15 minutes')
    );
$$;

-- Atomically marks up to job_limit ready records as processing and returns
-- them. With only_id, claims that record if it is ready or was just set to
-- processing by an app version from before this queue existed.
create or replace function public.claim_ai_jobs(job_limit integer default 3, only_id uuid default null)
returns table (id uuid)
language sql
set search_path = ''
as $$
  update public.records r
  set ai_status = 'processing',
      ai_error = null,
      ai_attempts = r.ai_attempts + 1,
      updated_at = now()
  where r.id in (
    select c.id
    from public.records c
    where (only_id is null or c.id = only_id)
      and (
        public.ai_job_ready(c)
        or (only_id is not null and c.ai_status = 'processing' and c.cover_path is not null and c.ai_attempts < 3)
      )
    order by c.created_at
    limit job_limit
    for update skip locked
  )
  returning r.id;
$$;

revoke execute on function public.claim_ai_jobs(integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_ai_jobs(integer, uuid) to service_role;

-- Records that used up their attempts while stuck end as an error the user can retry.
create or replace function public.dispatch_ai_jobs()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.records
  set ai_status = 'error',
      ai_error = 'AI解析が完了しませんでした。詳細画面から再調査できます。',
      updated_at = now()
  where ai_status = 'processing'
    and ai_attempts >= 3
    and updated_at < now() - interval '15 minutes';

  if exists (select 1 from public.records r where public.ai_job_ready(r)) then
    perform net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'analyze_worker_url'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'analyze_worker_secret')
      ),
      body := '{}'::jsonb
    );
  end if;
end;
$$;

revoke execute on function public.dispatch_ai_jobs() from public, anon, authenticated;

select cron.unschedule('dispatch-ai-jobs') where exists (select 1 from cron.job where jobname = 'dispatch-ai-jobs');
select cron.schedule('dispatch-ai-jobs', '* * * * *', 'select public.dispatch_ai_jobs()');
