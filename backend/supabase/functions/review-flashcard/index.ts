// =====================================================================
// Edge Function: review-flashcard
// Two things, both scoped to the signed-in student via RLS + service role:
//
//   1. Review an existing card:
//        POST { "action": "review", "card_id": "...", "quality": 0|3|4|5 }
//      quality follows the simplified SM-2 scale: 0=Again, 3=Hard, 4=Good, 5=Easy.
//      Recomputes ease_factor / repetitions / interval_days / next_review_date,
//      the same algorithm the frontend's demo-mode sm2Review() uses.
//
//   2. Add a manual card:
//        POST { "action": "create", "topic": "...", "question": "...", "answer": "..." }
//
// Deploy:  supabase functions deploy review-flashcard
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

function addDaysISO(n: number) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// Simplified SM-2, matching frontend's sm2Review() exactly so demo and live
// mode schedule cards identically.
function sm2(card: { ease_factor: number; repetitions: number; interval_days: number }, quality: number) {
  let { ease_factor: ease, repetitions: reps, interval_days: interval } = card;
  if (quality < 3) {
    reps = 0;
    interval = 1;
  } else {
    ease = Math.max(1.3, +(ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))).toFixed(2));
    reps += 1;
    interval = reps === 1 ? 1 : reps === 2 ? 6 : Math.round(interval * ease);
  }
  return { ease_factor: ease, repetitions: reps, interval_days: interval, next_review_date: addDaysISO(interval) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

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

    const body = await req.json();

    if (body.action === "create") {
      const { topic, question, answer, explanation } = body as { topic?: string; question?: string; answer?: string; explanation?: string };
      if (!topic || !question || !answer) return json({ error: "topic, question and answer are required" }, 400);
      const { data, error } = await admin
        .from("flashcards")
        .insert({ student_id: user.id, topic, question, answer, explanation: explanation ?? null, source: "manual" })
        .select()
        .single();
      if (error) return json({ error: error.message }, 500);
      return json({ card: data });
    }

    // default action: "review"
    const { card_id, quality } = body as { card_id?: string; quality?: number };
    if (!card_id || typeof quality !== "number") return json({ error: "card_id and quality are required" }, 400);

    const { data: card, error: fetchErr } = await admin
      .from("flashcards")
      .select("id, ease_factor, repetitions, interval_days")
      .eq("id", card_id)
      .eq("student_id", user.id) // belt-and-suspenders alongside RLS
      .single();
    if (fetchErr || !card) return json({ error: "Flashcard not found" }, 404);

    const next = sm2(card, quality);
    const { data: updated, error: updateErr } = await admin
      .from("flashcards")
      .update({ ...next, updated_at: new Date().toISOString() })
      .eq("id", card_id)
      .select()
      .single();
    if (updateErr) return json({ error: updateErr.message }, 500);

    return json({ card: updated });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
