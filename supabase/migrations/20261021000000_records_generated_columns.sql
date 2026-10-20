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
