create table if not exists public.records (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  data jsonb not null default '{}'::jsonb,
  cover_path text,
  ai_status text not null default 'pending' check (ai_status in ('pending','processing','complete','review','error')),
  ai_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.records enable row level security;
grant select, insert, update, delete on public.records to authenticated;
create index if not exists records_user_id_idx on public.records(user_id);

create policy "records_select_own" on public.records for select to authenticated using ((select auth.uid()) = user_id);
create policy "records_insert_own" on public.records for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "records_update_own" on public.records for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "records_delete_own" on public.records for delete to authenticated using ((select auth.uid()) = user_id);

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('record-covers','record-covers',false,10485760,array['image/jpeg','image/png','image/webp','image/heic','image/heif'])
on conflict (id) do nothing;

create policy "covers_select_own" on storage.objects for select to authenticated using (bucket_id='record-covers' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy "covers_insert_own" on storage.objects for insert to authenticated with check (bucket_id='record-covers' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy "covers_update_own" on storage.objects for update to authenticated using (bucket_id='record-covers' and (storage.foldername(name))[1]=(select auth.uid())::text) with check (bucket_id='record-covers' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy "covers_delete_own" on storage.objects for delete to authenticated using (bucket_id='record-covers' and (storage.foldername(name))[1]=(select auth.uid())::text);
