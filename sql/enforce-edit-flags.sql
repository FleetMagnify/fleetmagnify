-- Enforce the "can edit assets" permission in the database for full-access
-- team members (previously only the screens enforced it).
-- Round 1 applied to production 21 Oct 2026 as migration
-- "enforce_can_edit_assets_for_full_members_a". Reference copy only: do NOT run.
--
-- Owner: always allowed. Full-access member (scope 'all'): needs can_edit_assets.
-- Divisional managers (scope 'division') are covered by their own policies.

create or replace function private.can_edit_account_assets(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select auth.uid() = target_user_id
  or exists (
    select 1 from account_members
    where account_owner_user_id = target_user_id
      and member_auth_user_id = auth.uid()
      and coalesce(scope, 'all') = 'all'
      and coalesce(can_edit_assets, false)
  );
$$;

revoke all on function private.can_edit_account_assets(uuid) from public, anon;
grant execute on function private.can_edit_account_assets(uuid) to authenticated;

alter policy "Enable insert for users based on user_id" on public.assets
  with check (private.can_edit_account_assets((user_id)::uuid));

alter policy "Enable update for users based on user_id" on public.assets
  using (private.can_edit_account_assets((user_id)::uuid))
  with check (private.can_edit_account_assets((user_id)::uuid));

-- Also applied 21 Oct 2026 (migration "revoke_anon_public_table_grants"):
-- all privileges on the 17 public data tables revoked from the anon role, and
-- default privileges for new postgres-owned objects in public no longer grant to anon.

-- ---------------------------------------------------------------------------
-- Round 2, applied 21 Oct 2026 after PR 49 (screens respect the ticks).
-- Migrations "enforce_can_edit_jobs_for_full_members" and
-- "enforce_can_edit_assets_on_payloads_overrides_aliases".
-- ---------------------------------------------------------------------------

-- Owner, or a full-access member whose can_edit_jobs tick is on.
create or replace function private.can_edit_account_jobs(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select auth.uid() = target_user_id
  or exists (
    select 1 from account_members
    where account_owner_user_id = target_user_id
      and member_auth_user_id = auth.uid()
      and coalesce(scope, 'all') = 'all'
      and coalesce(can_edit_jobs, false)
  );
$$;

revoke all on function private.can_edit_account_jobs(uuid) from public, anon;
grant execute on function private.can_edit_account_jobs(uuid) to authenticated;

alter policy "Enable insert for users based on user_id" on public.jobs
  with check (private.can_edit_account_jobs(user_id));
alter policy "Account members can update jobs" on public.jobs
  using (private.can_edit_account_jobs(user_id))
  with check (private.can_edit_account_jobs(user_id));
alter policy "Account members can delete jobs" on public.jobs
  using (private.can_edit_account_jobs(user_id));
alter policy "Enable insert for users based on user_id" on public.job_assets
  with check (private.can_edit_account_jobs(user_id));
-- Was owner-only although the screen offers it to members with the jobs tick.
alter policy "Enable delete for users based on user_id" on public.job_assets
  using (private.can_edit_account_jobs(user_id));

-- vehicle_id_aliases: writes need the edit-assets tick.
alter policy "Users can insert own vehicle aliases" on public.vehicle_id_aliases
  with check (private.can_edit_account_assets(user_id));
alter policy "Users can update own vehicle aliases" on public.vehicle_id_aliases
  using (private.can_edit_account_assets(user_id))
  with check (private.can_edit_account_assets(user_id));
alter policy "Users can delete own vehicle aliases" on public.vehicle_id_aliases
  using (private.can_edit_account_assets(user_id));

-- truck_cost_overrides: insert and delete need the tick (delete was owner-only).
-- There was no member update policy at all, so editing an existing override
-- matched zero rows; add one.
alter policy "insert own truck_cost_overrides" on public.truck_cost_overrides
  with check (private.can_edit_account_assets(user_id));
alter policy "delete own truck_cost_overrides" on public.truck_cost_overrides
  using (private.can_edit_account_assets(user_id));
create policy "Members with edit assets update truck_cost_overrides"
  on public.truck_cost_overrides for update to authenticated
  using (private.can_edit_account_assets(user_id))
  with check (private.can_edit_account_assets(user_id));

-- truck_payloads: one broad ALL policy covers read and write, so it cannot be
-- narrowed in place. Restrictive write policies apply on top of it. Divisional
-- managers pass this gate only for the account they manage; their own
-- policies then decide what they may actually change.
create policy "Edit assets tick required to insert truck_payloads"
  on public.truck_payloads as restrictive for insert to authenticated
  with check (private.can_edit_account_assets(user_id)
              or user_id in (select private.division_account_owner_ids()));
create policy "Edit assets tick required to update truck_payloads"
  on public.truck_payloads as restrictive for update to authenticated
  using (private.can_edit_account_assets(user_id)
         or user_id in (select private.division_account_owner_ids()))
  with check (private.can_edit_account_assets(user_id)
              or user_id in (select private.division_account_owner_ids()));
create policy "Edit assets tick required to delete truck_payloads"
  on public.truck_payloads as restrictive for delete to authenticated
  using (private.can_edit_account_assets(user_id)
         or user_id in (select private.division_account_owner_ids()));
