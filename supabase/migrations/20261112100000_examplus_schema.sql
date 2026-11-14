create table if not exists public.exam_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.students (
  id uuid primary key default gen_random_uuid(),
  nis text not null unique,
  name text not null,
  original_class text not null,
  device_id text
);

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  room_name text not null unique,
  proctor_code text not null unique,
  active_token text unique,
  constraint rooms_active_token_format
    check (active_token is null or active_token ~ '^[0-9]{6}$')
);

create table if not exists public.exam_sessions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  gform_url text not null,
  start_time timestamptz not null,
  end_time timestamptz not null,
  is_active boolean not null default false,
  constraint exam_sessions_time_window check (end_time > start_time),
  constraint exam_sessions_gform_url
    check (gform_url ~ '^https://docs\.google\.com/')
);

create table if not exists public.participant_allocations (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students (id) on delete cascade,
  room_id uuid not null references public.rooms (id) on delete restrict,
  session_id uuid not null references public.exam_sessions (id) on delete cascade,
  seat_number integer not null check (seat_number > 0),
  constraint participant_allocations_student_per_session unique (student_id, session_id),
  constraint participant_allocations_seat_per_room unique (session_id, room_id, seat_number)
);

create table if not exists public.exam_logs (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.students (id) on delete cascade,
  session_id uuid not null references public.exam_sessions (id) on delete cascade,
  status text not null default 'logged_in'
    constraint exam_logs_status_valid
      check (status in ('logged_in', 'in_exam', 'finished', 'blocked')),
  violation_count integer not null default 0 check (violation_count >= 0),
  last_heartbeat timestamptz not null default now(),
  constraint exam_logs_student_per_session unique (student_id, session_id)
);

alter table public.exam_logs
  add column if not exists status text not null default 'logged_in';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.exam_logs'::regclass
      and conname = 'exam_logs_status_valid'
  ) then
    alter table public.exam_logs
      add constraint exam_logs_status_valid
      check (status in ('logged_in', 'in_exam', 'finished', 'blocked'));
  end if;
end;
$$;

create index if not exists participant_allocations_room_session_idx
  on public.participant_allocations (session_id, room_id);
create index if not exists exam_logs_session_status_idx
  on public.exam_logs (session_id, status);
create index if not exists exam_logs_last_heartbeat_idx
  on public.exam_logs (last_heartbeat desc);

create or replace function public.is_exam_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.exam_admins
    where user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_exam_admin() from public;
grant execute on function public.is_exam_admin() to authenticated;

alter table public.exam_admins enable row level security;
alter table public.students enable row level security;
alter table public.rooms enable row level security;
alter table public.exam_sessions enable row level security;
alter table public.participant_allocations enable row level security;
alter table public.exam_logs enable row level security;

drop policy if exists "Admins can view their own admin record" on public.exam_admins;
create policy "Admins can view their own admin record"
  on public.exam_admins for select
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "Admins can manage students" on public.students;
create policy "Admins can manage students"
  on public.students for all
  to authenticated
  using ((select public.is_exam_admin()))
  with check ((select public.is_exam_admin()));

drop policy if exists "Admins can manage rooms" on public.rooms;
create policy "Admins can manage rooms"
  on public.rooms for all
  to authenticated
  using ((select public.is_exam_admin()))
  with check ((select public.is_exam_admin()));

drop policy if exists "Admins can manage exam sessions" on public.exam_sessions;
create policy "Admins can manage exam sessions"
  on public.exam_sessions for all
  to authenticated
  using ((select public.is_exam_admin()))
  with check ((select public.is_exam_admin()));

drop policy if exists "Admins can manage participant allocations" on public.participant_allocations;
create policy "Admins can manage participant allocations"
  on public.participant_allocations for all
  to authenticated
  using ((select public.is_exam_admin()))
  with check ((select public.is_exam_admin()));

drop policy if exists "Admins can manage exam logs" on public.exam_logs;
create policy "Admins can manage exam logs"
  on public.exam_logs for all
  to authenticated
  using ((select public.is_exam_admin()))
  with check ((select public.is_exam_admin()));

grant select on public.exam_admins to authenticated;
grant select, insert, update, delete
  on public.students, public.rooms, public.exam_sessions,
     public.participant_allocations, public.exam_logs
  to authenticated;

revoke all on public.exam_admins, public.students, public.rooms,
  public.exam_sessions, public.participant_allocations, public.exam_logs
  from public, anon;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1
       from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'exam_logs'
     ) then
    execute 'alter publication supabase_realtime add table public.exam_logs';
  end if;
end;
$$;
