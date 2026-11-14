import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type ParticipantAction = "join" | "heartbeat" | "focus_loss" | "finish";

type ParticipantRequest = {
  action?: ParticipantAction;
  nis?: string;
  participant_token?: string;
  room_token?: string;
  session_id?: string;
};

function respond(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function sessionIsInWindow(session: { start_time: string; end_time: string }, now: string) {
  const timestamp = Date.parse(now);
  return Date.parse(session.start_time) <= timestamp && Date.parse(session.end_time) >= timestamp;
}

async function loginRateLimitKey(address: string, nis: string) {
  const source = new TextEncoder().encode(`${address}\u0000${nis.toLowerCase()}`);
  const digest = await crypto.subtle.digest("SHA-256", source);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") return respond({ error: "Metode tidak diizinkan." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Participant endpoint is missing Supabase server configuration.");
    return respond({ error: "Layanan peserta belum dikonfigurasi." }, 500);
  }

  let input: ParticipantRequest;
  try {
    input = await request.json();
  } catch {
    return respond({ error: "Permintaan tidak valid." }, 400);
  }

  const action = input.action;
  const nis = input.nis?.trim();
  const participantToken = input.participant_token?.trim();
  const roomToken = input.room_token?.trim();
  if (!action || !["join", "heartbeat", "focus_loss", "finish"].includes(action)) {
    return respond({ error: "Aksi tidak dikenali." }, 400);
  }
  if (!nis || (action !== "finish" && (!participantToken || !/^\d{6}$/.test(participantToken)))) {
    return respond({ error: "NIS atau token pelajaran tidak valid." }, 400);
  }
  if (action === "finish" && (!roomToken || !/^\d{6}$/.test(roomToken))) {
    return respond({ error: "Token ruang tidak valid." }, 400);
  }

  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const now = new Date().toISOString();

  try {
    if (action === "join") {
      const sourceAddress = request.headers.get("cf-connecting-ip")?.trim() || "shared";
      const bucketKey = await loginRateLimitKey(sourceAddress, nis);
      const { data: loginAllowed, error: rateLimitError } = await db
        .rpc("participant_allow_login_attempt", { p_bucket_key: bucketKey });
      if (rateLimitError) throw rateLimitError;
      if (!loginAllowed) return respond({ error: "Terlalu banyak percobaan masuk. Tunggu 10 menit lalu coba lagi." }, 429);
    }

    if (action !== "join" && !input.session_id) return respond({ error: "Sesi tidak valid." }, 400);
    const sessionLookup = action === "join"
      ? db.from("exam_sessions")
        .select("id,title,gform_url,start_time,end_time,is_active")
        .eq("participant_token", participantToken!)
        .maybeSingle()
      : action === "finish"
        ? db.from("exam_sessions")
          .select("id,title,gform_url,start_time,end_time,is_active")
          .eq("id", input.session_id!)
          .maybeSingle()
        : db.from("exam_sessions")
          .select("id,title,gform_url,start_time,end_time,is_active")
          .eq("id", input.session_id!)
          .eq("participant_token", participantToken!)
          .maybeSingle();
    const [{ data: session, error: sessionError }, { data: student, error: studentError }] = await Promise.all([
      sessionLookup,
      db.from("students").select("id,nis,name").eq("nis", nis).maybeSingle(),
    ]);
    if (sessionError) throw sessionError;
    if (studentError) throw studentError;
    if (!session || !student) return respond({ error: "NIS, token pelajaran, atau sesi tidak cocok." }, 403);
    const sessionId = session.id;

    const { data: allocation, error: allocationError } = await db
      .from("participant_allocations")
      .select("room_id,seat_number")
      .eq("student_id", student.id)
      .eq("session_id", sessionId)
      .maybeSingle();
    if (allocationError) throw allocationError;
    if (!allocation) return respond({ error: "NIS, token pelajaran, atau sesi tidak cocok." }, 403);
    const { data: room, error: roomError } = await db
      .from("rooms")
      .select("id,room_name,active_token")
      .eq("id", allocation.room_id)
      .maybeSingle();
    if (roomError) throw roomError;
    if (!room) return respond({ error: "Ruang alokasi tidak ditemukan." }, 403);

    const { data: existingLog, error: logError } = await db
      .from("exam_logs")
      .select("id,status,violation_count")
      .eq("student_id", student.id)
      .eq("session_id", sessionId)
      .maybeSingle();
    if (logError) throw logError;

    if (action === "join") {
      if (!session.is_active || !sessionIsInWindow(session, now)) {
        return respond({ error: "Sesi ujian tidak sedang menerima peserta." }, 403);
      }
      if (existingLog?.status === "blocked") return respond({ error: "Akses diblokir. Minta bantuan pengawas." }, 423);
      if (existingLog?.status === "finished") return respond({ error: "Ujian untuk akun ini sudah ditandai selesai." }, 403);

      let log = existingLog;
      if (!log) {
        const { data: inserted, error: insertError } = await db
          .from("exam_logs")
          .insert({ student_id: student.id, session_id: sessionId, status: "logged_in", last_heartbeat: now })
          .select("id,status,violation_count")
          .single();
        if (insertError?.code === "23505") {
          const { data: racedLog, error: racedLogError } = await db
            .from("exam_logs")
            .select("id,status,violation_count")
            .eq("student_id", student.id)
            .eq("session_id", sessionId)
            .single();
          if (racedLogError) throw racedLogError;
          log = racedLog;
        } else if (insertError) {
          throw insertError;
        } else {
          log = inserted;
        }
      } else {
        const { error: heartbeatError } = await db
          .from("exam_logs")
          .update({ last_heartbeat: now })
          .eq("id", log.id);
        if (heartbeatError) throw heartbeatError;
      }

      if (log?.status === "blocked") return respond({ error: "Akses diblokir. Minta bantuan pengawas." }, 423);
      if (log?.status === "finished") return respond({ error: "Ujian untuk akun ini sudah ditandai selesai." }, 403);
      return respond({
        session: {
          id: session.id,
          title: session.title,
          gform_url: session.gform_url,
          end_time: session.end_time,
        },
        participant: {
          name: student.name,
          nis: student.nis,
          room_name: room.room_name,
          seat_number: allocation.seat_number,
        },
        status: log?.status || "logged_in",
      });
    }

    if (!session.is_active && action !== "finish") {
      return respond({ error: "Sesi ujian sudah tidak aktif." }, 403);
    }
    if (!sessionIsInWindow(session, now)) {
      if (action !== "finish") return respond({ error: "Waktu sesi ujian telah berakhir." }, 403);
    }
    if (!existingLog) return respond({ error: "Catatan ujian tidak ditemukan. Silakan masuk kembali." }, 404);
    if (existingLog.status === "blocked" && action !== "finish") {
      return respond({ error: "Akses diblokir. Minta bantuan pengawas." }, 423);
    }
    if (existingLog.status === "finished" && action !== "finish") {
      return respond({ error: "Ujian untuk akun ini sudah ditandai selesai." }, 403);
    }

    if (action === "focus_loss") {
      const { data: violationCount, error: violationError } = await db
        .rpc("participant_record_violation", { p_exam_log_id: existingLog.id });
      if (violationError) throw violationError;
      return respond({ status: existingLog.status, violation_count: violationCount });
    }

    if (action === "heartbeat") {
      const { error: heartbeatError } = await db
        .from("exam_logs")
        .update({ last_heartbeat: now })
        .eq("id", existingLog.id);
      if (heartbeatError) throw heartbeatError;
      return respond({ status: existingLog.status });
    }

    if (action === "finish") {
      if (roomToken !== room.active_token) {
        return respond({ error: "Token ruang salah. Ujian tetap terkunci." }, 403);
      }
      const { error: finishError } = await db
        .from("exam_logs")
        .update({ status: "finished", last_heartbeat: now })
        .eq("id", existingLog.id);
      if (finishError) throw finishError;
      return respond({ status: "finished" });
    }

    return respond({ error: "Aksi tidak dikenali." }, 400);
  } catch (error) {
    console.error("Participant endpoint failed:", error);
    return respond({ error: "Terjadi kesalahan pada layanan peserta." }, 500);
  }
});
