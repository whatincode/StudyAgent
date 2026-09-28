// =====================================================================
// Edge Function: get-assessment-analytics   (Member 4)
//
// Returns a student's REAL assessment analytics, knowledge-gap map, mistake
// summary and structured evidence, computed from the existing tables
// (quiz_attempts, quizzes, mistakes). The answer key is never read or returned.
//
// Deploy:  supabase functions deploy get-assessment-analytics
//
// Student (frontend):
//   GET /functions/v1/get-assessment-analytics
//   Authorization: Bearer <user's access token>
//
// Member 3's server-side code (same guard as write-recommendation):
//   GET /functions/v1/get-assessment-analytics?student_id=<uuid>
//   x-internal-key: <INTERNAL_API_KEY>
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { loadAttemptRecords, loadMistakeRecords } from "../_shared/assessment/assessmentEngine.ts";
import { computeAnalytics } from "../_shared/assessment/analyticsEngine.ts";
import { buildKnowledgeGapMap } from "../_shared/assessment/knowledgeGapEngine.ts";
import { buildStudentEvidence } from "../_shared/assessment/evidenceEngine.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-key",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return json({ error: "GET only" }, 405);

  try {
    // ---- 1. Work out whose data this is
    let studentId: string;
    const internalKey = req.headers.get("x-internal-key");
    if (internalKey) {
      if (internalKey !== Deno.env.get("INTERNAL_API_KEY")) return json({ error: "Unauthorized" }, 401);
      const requested = new URL(req.url).searchParams.get("student_id");
      if (!requested) return json({ error: "student_id is required with x-internal-key" }, 400);
      studentId = requested;
    } else {
      const userClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
      );
      const { data: { user }, error: userErr } = await userClient.auth.getUser();
      if (userErr || !user) return json({ error: "Not authenticated" }, 401);
      studentId = user.id; // a student can only ever read their own data
    }

    // ---- 2. Read real records (service role, always filtered by studentId)
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const [attempts, mistakes] = await Promise.all([
      loadAttemptRecords(admin, studentId),
      loadMistakeRecords(admin, studentId),
    ]);

    // ---- 3. Member 4 modules
    const analytics = computeAnalytics(attempts);
    const knowledgeGaps = buildKnowledgeGapMap(analytics.topicPerformance);
    const studentEvidence = buildStudentEvidence({ studentId, analytics, knowledgeGaps, mistakes });

    return json({
      studentId,
      generatedAt: studentEvidence.generatedAt,
      overall: {
        accuracy: analytics.overallAccuracy,
        totalQuestions: analytics.totalQuestions,
        correct: analytics.totalCorrect,
        incorrect: analytics.totalIncorrect,
        quizzes: analytics.quizzesTaken,
        recentPerformance: analytics.recentPerformance,
        attemptHistory: analytics.attemptHistory,
      },
      topicPerformance: analytics.topicPerformance,
      difficultyPerformance: analytics.difficultyPerformance,
      mistakes: studentEvidence.mistakes,
      knowledgeGaps,
      evidence: studentEvidence.evidence,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
