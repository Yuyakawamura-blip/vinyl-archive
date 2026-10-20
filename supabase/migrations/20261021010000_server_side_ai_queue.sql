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
