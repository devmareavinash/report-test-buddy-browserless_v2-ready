-- ============ Roles ============
create type public.app_role as enum ('admin', 'user');

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  role app_role not null,
  created_at timestamp with time zone not null default now(),
  unique (user_id, role)
);

alter table public.user_roles enable row level security;

create or replace function public.has_role(_user_id uuid, _role app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles where user_id = _user_id and role = _role
  )
$$;

create policy "Users can read own roles"
on public.user_roles for select to authenticated
using (auth.uid() = user_id);

create policy "Admins can read all roles"
on public.user_roles for select to authenticated
using (public.has_role(auth.uid(), 'admin'));

create policy "Admins can manage roles"
on public.user_roles for all to authenticated
using (public.has_role(auth.uid(), 'admin'))
with check (public.has_role(auth.uid(), 'admin'));

-- Auto-assign 'user' role on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_roles (user_id, role)
  values (new.id, 'user')
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- ============ Lock down sensitive config tables (admin-only) ============
do $$
declare t text;
begin
  for t in select unnest(array[
    'api_tokens','credential_profiles','llm_providers','warehouse_connectors',
    'browser_runtime','agent_model_config','schedules'
  ]) loop
    execute format('drop policy if exists "public_all_%s" on public.%I', t, t);
    execute format('create policy "Admins manage %s" on public.%I for all to authenticated using (public.has_role(auth.uid(), ''admin'')) with check (public.has_role(auth.uid(), ''admin''))', t, t);
  end loop;
end $$;

-- ============ App data tables (any signed-in user) ============
do $$
declare t text;
begin
  for t in select unnest(array[
    'workstreams','brands','reports','scenarios','runs','test_results','scripts',
    'sql_templates','prerun_scripts','scenario_filter_matrix','operator_notes',
    'note_memory','warehouse_mock','playwright_jobs'
  ]) loop
    execute format('drop policy if exists "public_all_%s" on public.%I', t, t);
    execute format('drop policy if exists "public_all_filter_matrix" on public.%I', t);
    execute format('create policy "Authenticated read %s" on public.%I for select to authenticated using (true)', t, t);
    execute format('create policy "Authenticated write %s" on public.%I for all to authenticated using (true) with check (true)', t, t);
  end loop;
end $$;

-- ============ Storage: artifacts bucket ============
-- Keep public read (screenshot URLs are referenced from test_results).
-- Restrict writes to authenticated users.
drop policy if exists "Public read artifacts" on storage.objects;
create policy "Public read artifacts"
on storage.objects for select to public
using (bucket_id = 'artifacts');

drop policy if exists "Auth insert artifacts" on storage.objects;
create policy "Auth insert artifacts"
on storage.objects for insert to authenticated
with check (bucket_id = 'artifacts');

drop policy if exists "Auth update artifacts" on storage.objects;
create policy "Auth update artifacts"
on storage.objects for update to authenticated
using (bucket_id = 'artifacts');

drop policy if exists "Auth delete artifacts" on storage.objects;
create policy "Auth delete artifacts"
on storage.objects for delete to authenticated
using (bucket_id = 'artifacts');