alter table public.students
  add column if not exists default_room_id uuid
  references public.rooms (id) on delete set null;

create index if not exists students_default_room_id_idx
  on public.students (default_room_id);
