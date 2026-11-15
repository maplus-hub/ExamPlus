import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type ProctorAction = "login" | "roster" | "mute_alarm" | "resume_participant";

type ProctorRequest = {
  action?: ProctorAction;
  room_name?: string;
  proctor_code?: string;
  session_id?: string;
  log_id?: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function respond(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function rateLimitKey(address: string, roomName: string) {
  const identity = `proctor\u0000${address}\u0000${roomName.toLowerCase()}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function checkFailedAttempt(db: ReturnType<typeof createClient>, request: Request, roomName: string) {
  const address = request.headers.get("cf-connecting-ip")?.trim() || "shared";
  const { data, error } = await db.rpc("participant_allow_login_attempt", {
    p_bucket_key: await rateLimitKey(address, roomName),
  });
  if (error) throw error;
  return data === true;
}

async function resolveRoom(
  db: ReturnType<typeof createClient>,
  request: Request,
  roomName: string,
  proctorCode: string,
) {
  const { data: room, error } = await db
    .from("rooms")
    .select("id,room_name")
    .eq("room_name", roomName)
    .eq("proctor_code", proctorCode)
    .maybeSingle();
  if (error) throw error;
  if (room) return { room, failure: null as Response | null };
  const allowed = await checkFailedAttempt(db, request, roomName);
  return {
    room: null,
    failure: respond(
      { error: allowed ? "Nama ruang atau kode pengawas tidak cocok." : "Terlalu banyak percobaan. Coba lagi dalam 10 menit." },
      allowed ? 403 : 429,
    ),
  };
}

async function listActiveSessions(db: ReturnType<typeof createClient>, roomId: string, now: string) {
  const { data: allocations, error: allocationError } = await db
    .from("participant_allocations")
    .select("session_id")
    .eq("room_id", roomId);
  if (allocationError) throw allocationError;
  const sessionIds = [...new Set((allocations || []).map((allocation) => allocation.session_id))];
  if (sessionIds.length === 0) return [];
  const { data: sessions, error: sessionError } = await db
    .from("exam_sessions")
    .select("id,title,start_time,end_time")
    .eq("is_active", true)
    .in("id", sessionIds)
    .lte("start_time", now)
    .gte("end_time", now)
    .order("start_time");
  if (sessionError) throw sessionError;
  return sessions || [];
}

async function loadRoster(db: ReturnType<typeof createClient>, roomId: string, sessionId: string) {
  const { data: allocations, error: allocationError } = await db
    .from("participant_allocations")
    .select("student_id,seat_number")
    .eq("room_id", roomId)
    .eq("session_id", sessionId)
    .order("seat_number");
  if (allocationError) throw allocationError;
  if (!allocations?.length) return null;

  const studentIds = allocations.map((allocation) => allocation.student_id);
  const [{ data: students, error: studentError }, { data: logs, error: logError }] = await Promise.all([
    db.from("students").select("id,nis,name,original_class").in("id", studentIds),
    db.from("exam_logs")
      .select("id,student_id,status,violation_count,last_heartbeat,alarm_active")
      .eq("session_id", sessionId)
      .in("student_id", studentIds),
  ]);
  if (studentError) throw studentError;
  if (logError) throw logError;

  const studentsById = new Map((students || []).map((student) => [student.id, student]));
  const logsByStudentId = new Map((logs || []).map((log) => [log.student_id, log]));
  return allocations.map((allocation) => {
    const student = studentsById.get(allocation.student_id);
    const log = logsByStudentId.get(allocation.student_id);
    return {
      log_id: log?.id || null,
      student_id: allocation.student_id,
      nis: student?.nis || "",
      name: student?.name || "Data peserta tidak ditemukan",
      original_class: student?.original_class || "",
      seat_number: allocation.seat_number,
      status: log?.status || "not_started",
      violation_count: log?.violation_count || 0,
      last_heartbeat: log?.last_heartbeat || null,
      alarm_active: log?.alarm_active === true,
    };
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") return respond({ error: "Metode tidak diizinkan." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Proctor endpoint is missing Supabase server configuration.");
    return respond({ error: "Layanan pengawas belum dikonfigurasi." }, 500);
  }

  let input: ProctorRequest;
  try {
    input = await request.json();
  } catch {
    return respond({ error: "Permintaan tidak valid." }, 400);
  }

  const action = input.action;
  const roomName = input.room_name?.trim();
  const proctorCode = input.proctor_code?.trim();
  if (!action || !["login", "roster", "mute_alarm", "resume_participant"].includes(action)) {
    return respond({ error: "Aksi tidak dikenali." }, 400);
  }
  if (!roomName || roomName.length > 120 || !proctorCode || proctorCode.length < 8 || proctorCode.length > 128) {
    return respond({ error: "Nama ruang atau kode pengawas tidak valid." }, 400);
  }
  if (action !== "login" && (!input.session_id || !UUID_PATTERN.test(input.session_id))) {
    return respond({ error: "Pelajaran tidak valid." }, 400);
  }
  if ((action === "mute_alarm" || action === "resume_participant") &&
    (!input.log_id || !UUID_PATTERN.test(input.log_id))) {
    return respond({ error: "Catatan peserta tidak valid." }, 400);
  }

  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const { room, failure } = await resolveRoom(db, request, roomName, proctorCode);
    if (failure) return failure;
    if (!room) return respond({ error: "Nama ruang atau kode pengawas tidak cocok." }, 403);

    if (action === "login") {
      return respond({
        room: { id: room.id, room_name: room.room_name },
        sessions: await listActiveSessions(db, room.id, new Date().toISOString()),
      });
    }

    const sessionId = input.session_id!;
    if (action === "roster") {
      const roster = await loadRoster(db, room.id, sessionId);
      if (!roster) return respond({ error: "Tidak ada peserta teralokasi untuk ruang dan pelajaran ini." }, 404);
      const { data: session, error: sessionError } = await db
        .from("exam_sessions")
        .select("id,title,start_time,end_time")
        .eq("id", sessionId)
        .maybeSingle();
      if (sessionError) throw sessionError;
      if (!session) return respond({ error: "Pelajaran tidak ditemukan." }, 404);
      return respond({ session, roster });
    }

    const { data: log, error: logError } = await db
      .from("exam_logs")
      .select("id,student_id,status")
      .eq("id", input.log_id!)
      .eq("session_id", sessionId)
      .maybeSingle();
    if (logError) throw logError;
    if (!log) return respond({ error: "Catatan peserta tidak ditemukan." }, 404);

    const { data: allocation, error: allocationError } = await db
      .from("participant_allocations")
      .select("id")
      .eq("room_id", room.id)
      .eq("session_id", sessionId)
      .eq("student_id", log.student_id)
      .maybeSingle();
    if (allocationError) throw allocationError;
    if (!allocation) return respond({ error: "Peserta bukan bagian dari ruang pengawas ini." }, 403);

    if (action === "mute_alarm") {
      const { error } = await db.from("exam_logs").update({ alarm_active: false }).eq("id", log.id);
      if (error) throw error;
      return respond({ status: log.status, alarm_active: false });
    }

    if (log.status !== "blocked") {
      return respond({ error: "Peserta tidak sedang diblokir." }, 409);
    }
    const { data: session, error: sessionError } = await db
      .from("exam_sessions")
      .select("is_active,start_time,end_time")
      .eq("id", sessionId)
      .maybeSingle();
    if (sessionError) throw sessionError;
    const now = Date.now();
    if (
      !session ||
      !session.is_active ||
      Date.parse(session.start_time) > now ||
      Date.parse(session.end_time) < now
    ) {
      return respond({ error: "Pelajaran sudah tidak aktif; peserta tidak dapat melanjutkan." }, 403);
    }
    const { data: updated, error: updateError } = await db
      .from("exam_logs")
      .update({ status: "in_exam", alarm_active: false, last_heartbeat: new Date().toISOString() })
      .eq("id", log.id)
      .eq("status", "blocked")
      .select("id")
      .maybeSingle();
    if (updateError) throw updateError;
    if (!updated) return respond({ error: "Status peserta berubah. Segarkan daftar peserta." }, 409);
    return respond({ status: "in_exam", alarm_active: false });
  } catch (error) {
    console.error("Proctor endpoint failed:", error);
    return respond({ error: "Terjadi kesalahan pada layanan pengawas." }, 500);
  }
});
