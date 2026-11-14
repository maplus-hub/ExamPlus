create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null,
  nis_nip text,
  role public.user_role not null default 'student'::public.user_role
);

alter table public.profiles enable row level security;

revoke all on public.profiles from public, anon, authenticated;
