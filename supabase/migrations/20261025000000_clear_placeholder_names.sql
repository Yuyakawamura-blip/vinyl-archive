-- Batch uploads used to store placeholder names ("AI解析待ち", "未解析レコード N")
-- and the AI wrote "AIリソースなし" when it found nothing. The app now leaves
-- unknown names empty and labels them on screen, so clear the stored ones.
update public.records
set data = data
  || case when data->>'artist' in ('AI解析待ち', 'AIリソースなし')
       then jsonb_build_object('artist', '') else '{}'::jsonb end
  || case when data->>'title' ~ '^未解析レコード [0-9]+$'
       then jsonb_build_object('title', '') else '{}'::jsonb end
where data->>'artist' in ('AI解析待ち', 'AIリソースなし')
   or data->>'title' ~ '^未解析レコード [0-9]+$';
