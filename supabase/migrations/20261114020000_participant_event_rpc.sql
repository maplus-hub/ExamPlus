create or replace function public.participant_record_violation(p_exam_log_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_count integer;
begin
  update public.exam_logs
  set violation_count = violation_count + 1,
      last_heartbeat = now()
  where id = p_exam_log_id
  returning violation_count into updated_count;

  if not found then
    raise exception 'Exam log not found';
  end if;

  return updated_count;
end;
$$;

revoke all on function public.participant_record_violation(uuid) from public, anon, authenticated;
grant execute on function public.participant_record_violation(uuid) to service_role;

do $$
begin
  if exists (
    select 1
    from public.exam_logs
    group by student_id, session_id
    having count(*) > 1
  ) then
    raise exception 'Duplicate exam_logs rows exist for the same student and session'
      using hint = 'Resolve duplicate rows before enabling the participant app.';
  end if;
end;
$$;

create unique index if not exists exam_logs_student_session_uidx
  on public.exam_logs (student_id, session_id);

create table if not exists public.participant_login_attempts (
  bucket_key text primary key check (bucket_key ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null default now(),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  blocked_until timestamptz
);

alter table public.participant_login_attempts enable row level security;
revoke all on public.participant_login_attempts from public, anon, authenticated;

create or replace function public.participant_allow_login_attempt(p_bucket_key text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_blocked_until timestamptz;
begin
  if p_bucket_key !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid rate-limit key';
  end if;

  insert into public.participant_login_attempts (bucket_key, attempt_count)
  values (p_bucket_key, 1)
  on conflict (bucket_key) do update
  set
    window_started_at = case
      when public.participant_login_attempts.window_started_at <= now() - interval '10 minutes'
        then now()
      else public.participant_login_attempts.window_started_at
    end,
    attempt_count = case
      when public.participant_login_attempts.window_started_at <= now() - interval '10 minutes'
        then 1
      else public.participant_login_attempts.attempt_count + 1
    end,
    blocked_until = case
      when public.participant_login_attempts.blocked_until > now()
        then public.participant_login_attempts.blocked_until
      when public.participant_login_attempts.window_started_at <= now() - interval '10 minutes'
        then null
      when public.participant_login_attempts.attempt_count + 1 >= 6
        then now() + interval '10 minutes'
      else null
    end
  returning blocked_until into current_blocked_until;

  return current_blocked_until is null or current_blocked_until <= now();
end;
$$;

revoke all on function public.participant_allow_login_attempt(text) from public, anon, authenticated;
grant execute on function public.participant_allow_login_attempt(text) to service_role;
