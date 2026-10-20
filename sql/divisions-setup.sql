-- divisions-setup.sql
-- APPLIED TO PRODUCTION on 21 Oct 2026 (as migrations divisions_a..d). Reference
-- copy for the repo; do not re-run against production. The vehicle_id_aliases
-- policies were changed with ALTER POLICY (names unchanged).
-- Optional "divisions" feature: an account owner groups assets into divisions,
-- invites divisional managers who only see (and, if permitted, edit) the assets
-- in the divisions they manage. Accounts with no divisions are unaffected.
--
-- Design notes
--  * Divisions are created/renamed/deleted ONLY through the server API (service
--    role), because creating a division changes the Stripe bill. Authenticated
--    users get SELECT only on divisions / division_managers.
--  * private.is_account_member() now returns true only for the owner and members
--    with scope = 'all' (NULL scope is treated as 'all'). Every existing policy
--    therefore excludes scope = 'division' members by default (fail closed).
--    Additive policies below grant divisional managers access to their assets.
--  * Grants are explicit (Supabase no longer auto-grants on new public tables
--    from 30 Oct 2026).

-- ---------------------------------------------------------------- tables
create table if not exists public.divisions (
  id bigint generated always as identity primary key,
  account_owner_user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  created_at timestamptz not null default now()
);
create unique index if not exists divisions_owner_name_key
  on public.divisions (account_owner_user_id, lower(btrim(name)));

create table if not exists public.division_managers (
  division_id bigint not null references public.divisions(id) on delete cascade,
  member_auth_user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (division_id, member_auth_user_id)
);
create index if not exists division_managers_member_idx
  on public.division_managers (member_auth_user_id);

alter table public.assets
  add column if not exists division_id bigint references public.divisions(id) on delete set null;
create index if not exists assets_division_id_idx
  on public.assets (division_id) where division_id is not null;

alter table public.account_members alter column scope set default 'all';
alter table public.account_members
  add constraint account_members_scope_check check (scope is null or scope in ('all', 'division'));

alter table public.divisions enable row level security;
alter table public.division_managers enable row level security;

revoke all on public.divisions, public.division_managers from public, anon, authenticated;
grant select on public.divisions, public.division_managers to authenticated;
grant select, insert, update, delete on public.divisions, public.division_managers to service_role;

-- ------------------------------------------------------------- functions
-- Owner + full-access members only. Divisional managers (scope = 'division') are excluded.
create or replace function private.is_account_member(target_user_id uuid)
returns boolean
language sql stable security definer
set search_path to 'public'
as $$
  select auth.uid() = target_user_id
  or exists (
    select 1 from account_members
    where account_owner_user_id = target_user_id
      and member_auth_user_id = auth.uid()
      and coalesce(scope, 'all') = 'all'
  );
$$;

create or replace function private.manages_division(p_division_id bigint)
returns boolean
language sql stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from division_managers dm
    join divisions d on d.id = dm.division_id
    join account_members am
      on am.member_auth_user_id = dm.member_auth_user_id
     and am.account_owner_user_id = d.account_owner_user_id
    where dm.division_id = p_division_id
      and dm.member_auth_user_id = auth.uid()
      and am.scope = 'division'
  );
$$;

create or replace function private.my_division_asset_ids()
returns setof bigint
language sql stable security definer
set search_path to 'public'
as $$
  select a.id
  from assets a
  join divisions d on d.id = a.division_id
  join division_managers dm on dm.division_id = d.id
  join account_members am
    on am.member_auth_user_id = dm.member_auth_user_id
   and am.account_owner_user_id = d.account_owner_user_id
  where dm.member_auth_user_id = auth.uid()
    and am.scope = 'division'
    and a.user_id = d.account_owner_user_id::text;
$$;

create or replace function private.my_division_job_ids()
returns setof bigint
language sql stable security definer
set search_path to 'public'
as $$
  select distinct ja.job_id
  from job_assets ja
  where ja.job_id is not null
    and ja.asset_id in (select private.my_division_asset_ids());
$$;

create or replace function private.division_account_owner_ids()
returns setof uuid
language sql stable security definer
set search_path to 'public'
as $$
  select account_owner_user_id
  from account_members
  where member_auth_user_id = auth.uid() and scope = 'division';
$$;

create or replace function private.division_manager_can_edit_assets()
returns boolean
language sql stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from account_members
    where member_auth_user_id = auth.uid()
      and scope = 'division'
      and coalesce(can_edit_assets, false)
  );
$$;

create or replace function private.division_matches_owner(p_division_id bigint, p_user_id text)
returns boolean
language sql stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from divisions
    where id = p_division_id and account_owner_user_id::text = p_user_id
  );
$$;

revoke execute on function
  private.manages_division(bigint),
  private.my_division_asset_ids(),
  private.my_division_job_ids(),
  private.division_account_owner_ids(),
  private.division_manager_can_edit_assets(),
  private.division_matches_owner(bigint, text)
from public, anon;
grant execute on function
  private.manages_division(bigint),
  private.my_division_asset_ids(),
  private.my_division_job_ids(),
  private.division_account_owner_ids(),
  private.division_manager_can_edit_assets(),
  private.division_matches_owner(bigint, text)
to authenticated, service_role;

-- Settings a divisional manager may read (they cannot read user_settings directly,
-- which also holds the upload email address).
create or replace function public.get_division_account_settings()
returns table (machinery_fuel_cost_per_litre numeric)
language sql stable security definer
set search_path to 'public'
as $$
  select us.machinery_fuel_cost_per_litre
  from user_settings us
  where us.user_id in (select private.division_account_owner_ids());
$$;
revoke execute on function public.get_division_account_settings() from public, anon;
grant execute on function public.get_division_account_settings() to authenticated, service_role;

-- ------------------------------------------------------------- triggers
-- An asset may only be placed in a division belonging to the same account.
create or replace function private.assets_validate_division()
returns trigger
language plpgsql security definer
set search_path to 'public'
as $$
begin
  if new.division_id is not null and not exists (
    select 1 from divisions d
    where d.id = new.division_id and d.account_owner_user_id::text = new.user_id
  ) then
    raise exception 'division does not belong to this account' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists assets_validate_division on public.assets;
create trigger assets_validate_division
  before insert or update of division_id, user_id on public.assets
  for each row execute function private.assets_validate_division();

-- Removing a team member removes their division assignments.
create or replace function private.account_members_cleanup_divisions()
returns trigger
language plpgsql security definer
set search_path to 'public'
as $$
begin
  delete from division_managers dm
  using divisions d
  where dm.division_id = d.id
    and dm.member_auth_user_id = old.member_auth_user_id
    and d.account_owner_user_id = old.account_owner_user_id;
  return old;
end;
$$;
drop trigger if exists account_members_cleanup_divisions on public.account_members;
create trigger account_members_cleanup_divisions
  after delete on public.account_members
  for each row execute function private.account_members_cleanup_divisions();

-- -------------------------------------------------------------- policies
-- New tables (read only; writes go through the server API)
create policy "divisions read" on public.divisions
  for select to authenticated
  using (private.is_account_member(account_owner_user_id) or private.manages_division(id));

create policy "division_managers read" on public.division_managers
  for select to authenticated
  using (
    member_auth_user_id = auth.uid()
    or exists (select 1 from public.divisions d where d.id = division_id and d.account_owner_user_id = auth.uid())
  );

-- assets
create policy "Division managers read their assets" on public.assets
  for select to authenticated
  using (id in (select private.my_division_asset_ids()));

create policy "Division managers insert assets in their divisions" on public.assets
  for insert to authenticated
  with check (
    private.division_manager_can_edit_assets()
    and division_id is not null
    and private.manages_division(division_id)
    and private.division_matches_owner(division_id, user_id)
  );

create policy "Division managers update their assets" on public.assets
  for update to authenticated
  using (id in (select private.my_division_asset_ids()) and private.division_manager_can_edit_assets())
  with check (
    private.division_manager_can_edit_assets()
    and division_id is not null
    and private.manages_division(division_id)
    and private.division_matches_owner(division_id, user_id)
  );

-- read-only asset-linked tables
create policy "Division managers read telematics_records" on public.telematics_records
  for select to authenticated using (asset_id in (select private.my_division_asset_ids()));
create policy "Division managers read fuel_records" on public.fuel_records
  for select to authenticated using (asset_id in (select private.my_division_asset_ids()));
create policy "Division managers read fuel_purchases" on public.fuel_purchases
  for select to authenticated using (vehicle_id in (select private.my_division_asset_ids()));
create policy "Division managers read eroad_mileage" on public.eroad_mileage
  for select to authenticated using (vehicle_id in (select private.my_division_asset_ids()));
create policy "Division managers read fuel_cost_calculations" on public.fuel_cost_calculations
  for select to authenticated using (vehicle_id in (select private.my_division_asset_ids()));
create policy "Division managers read job_assets" on public.job_assets
  for select to authenticated using (asset_id in (select private.my_division_asset_ids()));
create policy "Division managers read jobs" on public.jobs
  for select to authenticated using (id in (select private.my_division_job_ids()));

-- per-asset inputs a manager may maintain (requires can_edit_assets)
create policy "Division managers read truck_payloads" on public.truck_payloads
  for select to authenticated using (vehicle_id in (select private.my_division_asset_ids()));
create policy "Division managers insert truck_payloads" on public.truck_payloads
  for insert to authenticated
  with check (
    private.division_manager_can_edit_assets()
    and vehicle_id in (select private.my_division_asset_ids())
    and user_id in (select private.division_account_owner_ids())
  );
create policy "Division managers update truck_payloads" on public.truck_payloads
  for update to authenticated
  using (private.division_manager_can_edit_assets() and vehicle_id in (select private.my_division_asset_ids()))
  with check (
    private.division_manager_can_edit_assets()
    and vehicle_id in (select private.my_division_asset_ids())
    and user_id in (select private.division_account_owner_ids())
  );
create policy "Division managers delete truck_payloads" on public.truck_payloads
  for delete to authenticated
  using (private.division_manager_can_edit_assets() and vehicle_id in (select private.my_division_asset_ids()));

create policy "Division managers read truck_cost_overrides" on public.truck_cost_overrides
  for select to authenticated using (vehicle_id in (select private.my_division_asset_ids()));
create policy "Division managers insert truck_cost_overrides" on public.truck_cost_overrides
  for insert to authenticated
  with check (
    private.division_manager_can_edit_assets()
    and vehicle_id in (select private.my_division_asset_ids())
    and user_id in (select private.division_account_owner_ids())
  );
create policy "Division managers update truck_cost_overrides" on public.truck_cost_overrides
  for update to authenticated
  using (private.division_manager_can_edit_assets() and vehicle_id in (select private.my_division_asset_ids()))
  with check (
    private.division_manager_can_edit_assets()
    and vehicle_id in (select private.my_division_asset_ids())
    and user_id in (select private.division_account_owner_ids())
  );
create policy "Division managers delete truck_cost_overrides" on public.truck_cost_overrides
  for delete to authenticated
  using (private.division_manager_can_edit_assets() and vehicle_id in (select private.my_division_asset_ids()));

-- vehicle_id_aliases: replace the direct account_members EXISTS clauses with the
-- scope-aware function (so divisional managers do not inherit full access), then
-- add read-only access for managers to aliases that map to their assets.
alter policy "Users can read own vehicle aliases" on public.vehicle_id_aliases
  using (private.is_account_member(user_id));
alter policy "Users can insert own vehicle aliases" on public.vehicle_id_aliases
  with check (private.is_account_member(user_id));
alter policy "Users can update own vehicle aliases" on public.vehicle_id_aliases
  using (private.is_account_member(user_id))
  with check (private.is_account_member(user_id));
alter policy "Users can delete own vehicle aliases" on public.vehicle_id_aliases
  using (private.is_account_member(user_id));
create policy "Division managers read vehicle aliases" on public.vehicle_id_aliases
  for select to authenticated using (asset_id in (select private.my_division_asset_ids()));

-- profiles: managers read the owner's profile (subscription status, company name)
create policy "Division managers read account owner profile" on public.profiles
  for select to authenticated using (id in (select private.division_account_owner_ids()));
