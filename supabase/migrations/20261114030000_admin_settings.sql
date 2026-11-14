create or replace function public.revoke_exam_admin(
  p_actor_user_id uuid,
  p_target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  admin_count bigint;
begin
  lock table public.exam_admins in exclusive mode;

  if p_actor_user_id = p_target_user_id then
    raise exception 'An admin cannot revoke their own access';
  end if;

  if not exists (
    select 1
    from public.exam_admins
    where user_id = p_actor_user_id
  ) then
    raise exception 'Only an admin can revoke access';
  end if;

  select count(*) into admin_count
  from public.exam_admins;

  if admin_count <= 1 then
    raise exception 'The last admin cannot be removed';
  end if;

  delete from public.exam_admins
  where user_id = p_target_user_id;

  if not found then
    raise exception 'Admin access was not found';
  end if;
end;
$$;

revoke all on function public.revoke_exam_admin(uuid, uuid) from public, anon, authenticated;
grant execute on function public.revoke_exam_admin(uuid, uuid) to service_role;
