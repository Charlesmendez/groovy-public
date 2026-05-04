-- Enforce global alias uniqueness per user across sessions.
-- This prevents the same alias number (e.g. #5) from referring to different
-- inbox actions in different sessions for the same user.

-- 1) Backfill duplicate (user_id, alias) rows by reassigning extra rows to
--    fresh alias numbers above the current max alias per user.
with base as (
  select
    user_id,
    coalesce(max(alias), 0) as max_alias
  from public.inbox_action_aliases
  group by user_id
),
dups as (
  select
    ranked.ctid,
    ranked.user_id,
    row_number() over (
      partition by ranked.user_id
      order by ranked.updated_at desc nulls last, ranked.created_at desc nulls last, ranked.action_id
    ) as reassignment_rank
  from (
    select
      iaa.ctid,
      iaa.user_id,
      iaa.action_id,
      iaa.created_at,
      iaa.updated_at,
      row_number() over (
        partition by iaa.user_id, iaa.alias
        order by iaa.updated_at desc nulls last, iaa.created_at desc nulls last, iaa.action_id
      ) as alias_rank
    from public.inbox_action_aliases iaa
  ) ranked
  where ranked.alias_rank > 1
)
update public.inbox_action_aliases target
set
  alias = base.max_alias + dups.reassignment_rank,
  updated_at = now()
from dups
join base
  on base.user_id = dups.user_id
where target.ctid = dups.ctid;

-- 2) Add hard uniqueness guarantee at DB level.
create unique index if not exists inbox_action_aliases_user_alias_unique_idx
  on public.inbox_action_aliases(user_id, alias);
