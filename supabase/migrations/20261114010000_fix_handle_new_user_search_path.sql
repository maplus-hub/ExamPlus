create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.profiles (id, full_name, nis_nip, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', 'User Baru'),
    new.raw_user_meta_data ->> 'nis_nip',
    coalesce(
      (new.raw_user_meta_data ->> 'role')::public.user_role,
      'student'::public.user_role
    )
  );
  return new;
end;
$function$;
