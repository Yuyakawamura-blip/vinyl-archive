alter table public.records drop constraint if exists records_ai_status_check;
alter table public.records add constraint records_ai_status_check
  check (ai_status in ('pending','processing','complete','review','error','no_resources'));
