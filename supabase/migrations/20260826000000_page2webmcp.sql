create table public.organizations (id uuid primary key, name text not null, created_at timestamptz not null default now());
create table public.memberships (organization_id uuid not null references public.organizations(id), user_id uuid not null references auth.users(id), role text not null check (role in ('owner', 'editor', 'viewer')), primary key (organization_id, user_id));
create table public.projects (id uuid primary key, organization_id uuid not null references public.organizations(id), name text not null, primary_origin text, created_at timestamptz not null default now());
create table public.capabilities (id uuid primary key, project_id uuid not null references public.projects(id), stable_name text not null, status text not null, created_at timestamptz not null default now());
create table public.releases (id uuid primary key, project_id uuid not null references public.projects(id), content_hash text not null unique, status text not null, created_at timestamptz not null default now());

alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.projects enable row level security;
alter table public.capabilities enable row level security;
alter table public.releases enable row level security;

revoke all on public.organizations, public.memberships, public.projects, public.capabilities, public.releases from anon, authenticated;
grant select, insert, update, delete on public.organizations, public.memberships, public.projects, public.capabilities, public.releases to authenticated;

create policy "members read organizations" on public.organizations for select to authenticated using (exists (select 1 from public.memberships m where m.organization_id = id and m.user_id = (select auth.uid())));
create policy "members read memberships" on public.memberships for select to authenticated using (user_id = (select auth.uid()));
create policy "members manage projects" on public.projects for all to authenticated using (exists (select 1 from public.memberships m where m.organization_id = projects.organization_id and m.user_id = (select auth.uid()) and m.role in ('owner','editor'))) with check (exists (select 1 from public.memberships m where m.organization_id = projects.organization_id and m.user_id = (select auth.uid()) and m.role in ('owner','editor')));
create policy "members manage capabilities" on public.capabilities for all to authenticated using (exists (select 1 from public.projects p join public.memberships m on m.organization_id = p.organization_id where p.id = capabilities.project_id and m.user_id = (select auth.uid()) and m.role in ('owner','editor'))) with check (exists (select 1 from public.projects p join public.memberships m on m.organization_id = p.organization_id where p.id = capabilities.project_id and m.user_id = (select auth.uid()) and m.role in ('owner','editor')));
create policy "owners publish releases" on public.releases for all to authenticated using (exists (select 1 from public.projects p join public.memberships m on m.organization_id = p.organization_id where p.id = releases.project_id and m.user_id = (select auth.uid()) and m.role = 'owner')) with check (exists (select 1 from public.projects p join public.memberships m on m.organization_id = p.organization_id where p.id = releases.project_id and m.user_id = (select auth.uid()) and m.role = 'owner'));
