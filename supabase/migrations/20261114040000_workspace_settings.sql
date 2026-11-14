create table if not exists public.workspace_settings (
  id boolean primary key default true check (id),
  school_name text not null default 'ExamPlus' check (length(trim(school_name)) > 0),
  timezone text not null default 'Asia/Jakarta',
  default_monitor_session_id uuid references public.exam_sessions (id) on delete set null,
  auto_refresh_seconds integer not null default 60
    check (auto_refresh_seconds in (0, 30, 60, 120)),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.workspace_settings enable row level security;

drop policy if exists "Admins can manage workspace settings" on public.workspace_settings;
create policy "Admins can manage workspace settings"
  on public.workspace_settings for all
  to authenticated
  using ((select public.is_exam_admin()))
  with check ((select public.is_exam_admin()));

grant select, insert, update on public.workspace_settings to authenticated;
revoke all on public.workspace_settings from public, anon;

insert into public.workspace_settings (id)
values (true)
on conflict (id) do nothing;
