import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type AdminRequest = {
  action?: "list" | "invite" | "remove";
  email?: string;
  user_id?: string;
};

function respond(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function findAuthUserByEmail(db: ReturnType<typeof createClient>, email: string) {
  for (let page = 1; ; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const user = data.users.find((candidate) => candidate.email?.toLowerCase() === email);
    if (user) return user;
    if (data.users.length < 1000) return null;
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return respond({ error: "Metode tidak diizinkan." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("Admin management endpoint is missing Supabase server configuration.");
    return respond({ error: "Layanan pengelolaan admin belum dikonfigurasi." }, 500);
  }

  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return respond({ error: "Sesi admin tidak valid. Silakan masuk kembali." }, 401);

  let input: AdminRequest;
  try {
    input = await request.json();
  } catch {
    return respond({ error: "Permintaan tidak valid." }, 400);
  }
  if (!input.action || !["list", "invite", "remove"].includes(input.action)) {
    return respond({ error: "Aksi tidak dikenali." }, 400);
  }

  const db = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const { data: authData, error: authError } = await db.auth.getUser(token);
    if (authError || !authData.user) return respond({ error: "Sesi admin tidak valid. Silakan masuk kembali." }, 401);
    const actorId = authData.user.id;

    const { data: actorMembership, error: membershipError } = await db
      .from("exam_admins")
      .select("user_id")
      .eq("user_id", actorId)
      .maybeSingle();
    if (membershipError) throw membershipError;
    if (!actorMembership) return respond({ error: "Hanya admin yang dapat mengelola akses admin." }, 403);

    if (input.action === "list") {
      const { data: admins, error: adminsError } = await db
        .from("exam_admins")
        .select("user_id,created_at")
        .order("created_at", { ascending: true });
      if (adminsError) throw adminsError;
      const results = await Promise.all((admins || []).map(async (admin) => {
        const { data, error } = await db.auth.admin.getUserById(admin.user_id);
        if (error) throw error;
        return {
          user_id: admin.user_id,
          email: data.user.email || "(email tidak tersedia)",
          created_at: admin.created_at,
        };
      }));
      return respond({ admins: results });
    }

    if (input.action === "invite") {
      const email = input.email?.trim().toLowerCase();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return respond({ error: "Masukkan alamat email admin yang valid." }, 400);
      }

      const existingUser = await findAuthUserByEmail(db, email);
      let userId = existingUser?.id;
      if (!userId) {
        const { data, error } = await db.auth.admin.inviteUserByEmail(email, {
          data: { role: "admin" },
        });
        if (error) throw error;
        userId = data.user?.id;
      }
      if (!userId) throw new Error("Supabase Auth tidak mengembalikan ID pengguna.");

      const { data: existingMembership, error: existingMembershipError } = await db
        .from("exam_admins")
        .select("user_id")
        .eq("user_id", userId)
        .maybeSingle();
      if (existingMembershipError) throw existingMembershipError;
      if (existingMembership) return respond({ error: "Pengguna tersebut sudah menjadi admin." }, 409);

      const { error: insertError } = await db.from("exam_admins").insert({ user_id: userId });
      if (insertError) throw insertError;
      return respond({ invited: !existingUser, email });
    }

    const targetId = input.user_id;
    if (!targetId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetId)) {
      return respond({ error: "ID admin tidak valid." }, 400);
    }
    const { error: revokeError } = await db.rpc("revoke_exam_admin", {
      p_actor_user_id: actorId,
      p_target_user_id: targetId,
    });
    if (revokeError) {
      const message = revokeError.message.includes("last admin")
        ? "Akses admin terakhir tidak dapat dicabut."
        : revokeError.message.includes("own access")
          ? "Anda tidak dapat mencabut akses admin sendiri."
          : "Akses admin tidak dapat dicabut. Periksa status admin tersebut.";
      return respond({ error: message }, 409);
    }
    return respond({ removed: true });
  } catch (error) {
    console.error("Admin management request failed:", error);
    return respond({ error: "Permintaan admin gagal. Periksa konfigurasi Auth dan database." }, 500);
  }
});
