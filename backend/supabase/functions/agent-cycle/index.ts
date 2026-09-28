// =====================================================================
// Edge Function: agent-cycle
//
// Runs the Study Agent's full Perceive -> Analyze -> Decide -> Act loop for
// the signed-in student and returns the trace. This is the endpoint the
// frontend's "Agent" page calls directly (e.g. a "Re-run cycle" button);
// submit-quiz-attempt also calls the same orchestrator internally so the
// loop runs automatically every time new evidence (a quiz attempt) arrives.
//
// Deploy:  supabase functions deploy agent-cycle
// Call:    POST /functions/v1/agent-cycle   (Authorization: Bearer <user token>)
// Returns: an AgentTrace (see _shared/agent/orchestrator.ts)
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runAgentCycle } from "../_shared/agent/orchestrator.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return json({ error: "Not authenticated" }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    if (req.method === "GET") {
      // Return recent runs instead of triggering a new one — lets the frontend show history.
      const { data, error } = await admin.from("agent_runs").select("*")
        .eq("student_id", user.id).order("created_at", { ascending: false }).limit(20);
      if (error) return json({ error: error.message }, 500);
      return json({ runs: data ?? [] });
    }

    let trigger = "manual";
    try {
      const body = await req.json();
      if (body && typeof body.trigger === "string") trigger = body.trigger.slice(0, 200);
    } catch { /* no body is fine */ }

    const trace = await runAgentCycle(admin, user.id, trigger);
    return json(trace);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
