-- A record's photo must live in its owner's Storage folder, in the form the
-- app writes (<user id>/<file>.<ext>). analyze-record already refuses other
-- paths; this stops any future code path from pointing a record at someone
-- else's photo (docs/checks/2026-10-28-security-static-review.md).
alter table public.records drop constraint if exists records_cover_path_owner_check;
alter table public.records add constraint records_cover_path_owner_check
  check (cover_path is null or cover_path ~ ('^' || user_id::text || '/[A-Za-z0-9_-]+\.[A-Za-z0-9]+$'));
