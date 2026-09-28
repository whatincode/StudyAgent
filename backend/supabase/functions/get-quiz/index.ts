import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function chooseDifficulty(accuracy: number | null) {
  if (accuracy === null) return "medium";
  if (accuracy < 40) return "easy";
  if (accuracy < 70) return "medium";
  return "hard";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return json({ error: "GET only" }, 405);

  try {
    const url = new URL(req.url);
    const quizId = url.searchParams.get("quiz_id");
    const requestedLimit = Number(url.searchParams.get("limit") ?? "5");
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(Math.floor(requestedLimit), 1), 20)
      : 5;

    if (!quizId) return json({ error: "quiz_id is required" }, 400);

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

    // Find this quiz and its topic first.
    const { data: quiz, error: quizErr } = await admin
      .from("quizzes")
      .select("id, topic, difficulty")
      .eq("id", quizId)
      .single();

    if (quizErr || !quiz) return json({ error: "Quiz not found" }, 404);

    // Recent performance on the same topic drives the next difficulty.
    const { data: topicQuizzes } = await admin
      .from("quizzes")
      .select("id")
      .eq("topic", quiz.topic);

    const topicQuizIds = (topicQuizzes ?? []).map((q) => q.id);

    let recentAccuracy: number | null = null;
    if (topicQuizIds.length > 0) {
      const { data: recentAttempts } = await admin
        .from("quiz_attempts")
        .select("score,total,completed_at")
        .eq("student_id", user.id)
        .in("quiz_id", topicQuizIds)
        .order("completed_at", { ascending: false })
        .limit(5);

      if (recentAttempts && recentAttempts.length > 0) {
        const correct = recentAttempts.reduce((sum, a) => sum + Number(a.score ?? 0), 0);
        const total = recentAttempts.reduce((sum, a) => sum + Number(a.total ?? 0), 0);
        if (total > 0) recentAccuracy = Math.round((correct / total) * 100);
      }
    }

    const difficulty = chooseDifficulty(recentAccuracy);

    // Never return the answer or explanation before submission.
    let { data: questions, error: qErr } = await admin
      .from("questions")
      .select("id, question, options, concept, difficulty")
      .eq("quiz_id", quizId)
      .eq("difficulty", difficulty)
      .limit(limit);

    // If 06_member4_assessment.sql has not been run yet, the concept/difficulty columns do not exist:
    // fall back to plain questions instead of failing the whole quiz.
    if (qErr) {
      const plain = await admin.from("questions").select("id, question, options").eq("quiz_id", quizId).limit(limit);
      if (plain.error) return json({ error: plain.error.message }, 500);
      return json({ quiz_id: quizId, topic: quiz.topic, adaptive: null, questions: plain.data ?? [] });
    }

    // Fallback keeps the quiz usable if the requested difficulty has too few rows.
    if (!questions || questions.length === 0) {
      const fallback = await admin
        .from("questions")
        .select("id, question, options, concept, difficulty")
        .eq("quiz_id", quizId)
        .limit(limit);
      questions = fallback.data ?? [];
      if (fallback.error) return json({ error: fallback.error.message }, 500);
    }

    return json({
      quiz_id: quizId,
      topic: quiz.topic,
      adaptive: {
        recent_accuracy: recentAccuracy,
        selected_difficulty: difficulty,
        rule: "<40 easy, 40-69 medium, >=70 hard",
      },
      questions,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
