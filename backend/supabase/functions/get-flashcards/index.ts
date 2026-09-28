// =====================================================================
// Edge Function: get-flashcards
// Returns the signed-in student's flashcards (RLS also enforces this,
// but we use the admin client for a clean single query with sorting).
//
// Deploy:  supabase functions deploy get-flashcards
// Call:    GET /functions/v1/get-flashcards
//          Authorization: Bearer <user's access token>
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return json({ error: "GET only" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return json({ error: "Not authenticated" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: cards, error } = await admin
      .from("flashcards")
      .select("id, topic, question, answer, explanation, ease_factor, interval_days, repetitions, next_review_date, source, created_at")
      .eq("student_id", user.id)
      .order("next_review_date", { ascending: true });

    if (error) return json({ error: error.message }, 500);

    const today = new Date().toISOString().slice(0, 10);
    const due = (cards ?? []).filter((c) => c.next_review_date <= today);

    return json({ due_count: due.length, due, all: cards ?? [] });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
