alter table public.exam_logs
  add column if not exists alarm_active boolean not null default false;

create or replace function public.participant_record_violation(
  p_exam_log_id uuid,
  p_pause_on_violation boolean
)
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
      status = case
        when p_pause_on_violation then 'blocked'
        else status
      end,
      alarm_active = case
        when p_pause_on_violation then true
        else alarm_active
      end,
      last_heartbeat = now()
  where id = p_exam_log_id
  returning violation_count into updated_count;

  if not found then
    raise exception 'Exam log not found';
  end if;

  return updated_count;
end;
$$;

revoke all on function public.participant_record_violation(uuid, boolean) from public, anon, authenticated;
grant execute on function public.participant_record_violation(uuid, boolean) to service_role;
