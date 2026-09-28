// =====================================================================
// Edge Function: get-agent-trust
//
// Exposes the outcome feedback loop that 07_agent_feedback_loop.sql
// added and the orchestrator's closeFeedbackLoop() already writes to
// on every agent-cycle run: `recommendations.outcome_delta` is the
// change in that topic's accuracy between when it was recommended and
// the next time the agent checked. This function just rolls the last
// 10 CHECKED recommendations into one auditable percentage — "the
// agent's last 10 recommendations improved your score X% of the
// time" — instead of leaving that signal buried in a jsonb trace only
// the orchestrator itself reads.
//
// No new tables or columns needed — this is read-only over data the
// orchestrator was already writing.
//
// Deploy:  supabase functions deploy get-agent-trust
// Call:    GET /functions/v1/get-agent-trust   (Authorization: Bearer <user token>)
// Returns: { trust_pct: number|null, sample_size, outcomes: [{topic, baseline, outcome, delta, improved}] }
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS, json, resolveStudent } from "../_shared/xai/evidence.ts";

const IMPROVED_DELTA = 8; // must match orchestrator.ts's IMPROVED_DELTA so "improved" means the same thing everywhere

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return json({ error: "GET only" }, 405);
  try {
    const who = await resolveStudent(req, createClient);
    if ("error" in who) return json({ error: who.error }, who.status);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data, error } = await admin.from("recommendations")
      .select("recommended_topic, baseline_accuracy, outcome_accuracy, outcome_delta, outcome_checked_at")
      .eq("student_id", who.studentId)
      .not("outcome_checked_at", "is", null)
      .order("outcome_checked_at", { ascending: false })
      .limit(10);
    if (error) return json({ error: error.message }, 500);

    const rows = data ?? [];
    const outcomes = rows.map((r) => ({
      topic: String(r.recommended_topic ?? "").replace(/ — Revision$/, ""),
      baseline: Math.round(Number(r.baseline_accuracy ?? 0)),
      outcome: Math.round(Number(r.outcome_accuracy ?? 0)),
      delta: Math.round(Number(r.outcome_delta ?? 0)),
      improved: Number(r.outcome_delta ?? 0) >= IMPROVED_DELTA,
    }));
    const trustPct = outcomes.length ? Math.round(100 * outcomes.filter((o) => o.improved).length / outcomes.length) : null;

    return json({ trust_pct: trustPct, sample_size: outcomes.length, outcomes });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
