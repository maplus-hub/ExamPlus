alter table public.exam_sessions
  add column if not exists participant_token text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.exam_sessions'::regclass
      and conname = 'exam_sessions_participant_token_format'
  ) then
    alter table public.exam_sessions
      add constraint exam_sessions_participant_token_format
      check (participant_token is null or participant_token ~ '^[0-9]{6}$');
  end if;
end;
$$;

create unique index if not exists exam_sessions_participant_token_uidx
  on public.exam_sessions (participant_token)
  where participant_token is not null;
