// =====================================================================
// Edge Function: submit-quiz-attempt
// Grades a quiz server-side (so the answer key never reaches the
// client), then writes the attempt, answers, updated progress, and any
// mistakes — all in one call, using the service role so it can bypass
// RLS safely on the server.
//
// Deploy:  supabase functions deploy submit-quiz-attempt
// Call:    POST /functions/v1/submit-quiz-attempt
//          Authorization: Bearer <user's access token>
//          Body: { "quiz_id": "...", "topic_id": "<lesson id, optional>",
//                  "answers": [{ "question_id": "...", "selected_answer": "..." }, ...] }
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
// Member 4 integration: rule-based mistake classification + attempt analysis
import { evaluateAttempt, loadAttemptRecords, loadQuestionHistory, normalizeDifficulty } from "../_shared/assessment/assessmentEngine.ts";
import { classifyMistake } from "../_shared/assessment/mistakeClassifier.ts";
import type { MistakeAnalysis } from "../_shared/assessment/types.ts";
// The Study Agent: every new attempt is fresh evidence, so the agent's
// Perceive/Analyze/Decide/Act loop re-runs right after grading, in the same
// request — the recommendation on screen is never stale.
import { runAgentCycle } from "../_shared/agent/orchestrator.ts";

// Browser access (added for the frontend): Supabase does not add CORS headers to Edge Function
// responses, and any request with an Authorization header triggers a preflight first.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};


async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), { status: 405 });
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), { status: 401 });
    }

    const body = await req.json();
    const { quiz_id, topic_id, answers } = body as {
      quiz_id: string;
      topic_id?: string;
      answers: { question_id: string; selected_answer: string }[];
    };

    if (!quiz_id || !Array.isArray(answers) || answers.length === 0) {
      return new Response(JSON.stringify({ error: "quiz_id and answers[] are required" }), { status: 400 });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 1. Fetch the real answer key server-side only.
    const questionIds = answers.map((a) => a.question_id);
    const { data: questions, error: qErr } = await admin
      .from("questions")
      .select("id, answer, quiz_id, question, explanation")
      .in("id", questionIds);

    if (qErr) return new Response(JSON.stringify({ error: qErr.message }), { status: 500 });

    const answerKey = new Map(questions.map((q) => [q.id, q.answer]));
    const questionMeta = new Map(questions.map((q) => [q.id, q]));

    // 2. Grade
    let correctCount = 0;
    const gradedAnswers = answers.map((a) => {
      const correct = answerKey.get(a.question_id) === a.selected_answer;
      if (correct) correctCount++;
      return { ...a, correct };
    });
    const total = answers.length;
    const score = correctCount;

    // 3. Insert the attempt
    const { data: attempt, error: attemptErr } = await admin
      .from("quiz_attempts")
      .insert({ student_id: user.id, quiz_id, score, total })
      .select()
      .single();

    if (attemptErr) return new Response(JSON.stringify({ error: attemptErr.message }), { status: 500 });

    // 4. Insert individual answers
    const answerRows = gradedAnswers.map((a) => ({
      attempt_id: attempt.id,
      question_id: a.question_id,
      selected_answer: a.selected_answer,
      correct: a.correct,
    }));
    const { error: answersErr } = await admin.from("answers").insert(answerRows);
    if (answersErr) return new Response(JSON.stringify({ error: answersErr.message }), { status: 500 });

    // 5. Update progress (if a topic_id / lesson was supplied)
    if (topic_id) {
      const accuracy = Math.round((score / total) * 100);
      await admin
        .from("progress")
        .upsert(
          { student_id: user.id, topic_id, completion: 100, accuracy, updated_at: new Date().toISOString() },
          { onConflict: "student_id,topic_id" }
        );
    }

    // 6. Log mistakes for wrong answers (classified by Member 4's rule-based classifier)
    const { data: quiz } = await admin.from("quizzes").select("topic, difficulty").eq("id", quiz_id).single();
    const topic = quiz?.topic ?? "Unknown";
    const wrongAnswers = gradedAnswers.filter((a) => !a.correct);
    const mistakeAnalysis: MistakeAnalysis[] = [];
    if (wrongAnswers.length > 0) {
      try {
        // What the student had done BEFORE this attempt, for the classifier's rules.
        const earlier = (await loadAttemptRecords(admin, user.id)).filter((r) => r.id !== attempt.id);
        const inTopic = earlier.filter((r) => r.topic === topic);
        const topicQuestionsBefore = inTopic.reduce((s, r) => s + r.total, 0);
        const topicCorrectBefore = inTopic.reduce((s, r) => s + r.score, 0);
        const history = await loadQuestionHistory(admin, earlier.map((r) => r.id), wrongAnswers.map((a) => a.question_id));
        for (const a of wrongAnswers) {
          const h = history.get(a.question_id);
          mistakeAnalysis.push(classifyMistake({
            questionId: a.question_id,
            topic,
            selectedAnswer: a.selected_answer,
            correctAnswer: String(answerKey.get(a.question_id) ?? ""),
            context: {
              topicQuestionsBefore,
              topicCorrectBefore,
              sameQuestionCorrectBefore: h?.correct ?? 0,
              sameQuestionWrongBefore: h?.wrong ?? 0,
            },
          }));
        }
      } catch (_e) {
        // Analytics must never break a quiz submission: fall back to the old default below.
        mistakeAnalysis.length = 0;
      }
      const analysisByQuestion = new Map(mistakeAnalysis.map((m) => [m.questionId, m]));
      const mistakeRows = wrongAnswers.map((a) => ({
        student_id: user.id,
        topic,
        error_type: analysisByQuestion.get(a.question_id)?.errorType ?? "conceptual",
        question_id: a.question_id,
        count: 1,
      }));
      await admin.from("mistakes").insert(mistakeRows);
    }

    // 6.5 Auto-generate a flashcard the 2nd time this student misses this exact
    // question (mirrors the frontend's demo-mode registerWrongAnswer rule).
    // Best-effort: a flashcard hiccup must never fail the quiz submission.
    try {
      for (const a of wrongAnswers) {
        const h = history.get(a.question_id);
        if ((h?.wrong ?? 0) === 1) { // this miss is the 2nd — the 1st was in an earlier attempt
          const { data: existing } = await admin
            .from("flashcards")
            .select("id")
            .eq("student_id", user.id)
            .eq("source_question_id", a.question_id)
            .maybeSingle();
          if (!existing) {
            const meta = questionMeta.get(a.question_id);
            await admin.from("flashcards").insert({
              student_id: user.id,
              topic,
              source_question_id: a.question_id,
              question: meta?.question ?? "(question)",
              answer: String(answerKey.get(a.question_id) ?? ""),
              explanation: meta?.explanation ?? null,
              source: "auto_from_mistake",
            });
          }
        }
      }
    } catch (_e) {
      // never let flashcard generation break a quiz submission
    }

    // 7. Per-attempt assessment (topic + difficulty breakdown) for the results screen
    const assessment = evaluateAttempt(
      gradedAnswers.map((a) => ({
        questionId: a.question_id,
        topic,
        difficulty: normalizeDifficulty(quiz?.difficulty),
        correct: a.correct,
        selectedAnswer: a.selected_answer,
      })),
    );

    // 8. Re-run the Study Agent now that there's new evidence. Never let an
    // agent hiccup fail the quiz submission the student is waiting on.
    let agentTrace = null;
    try {
      agentTrace = await runAgentCycle(admin, user.id, `quiz_attempt:${attempt.id}`);
    } catch (_e) {
      agentTrace = null;
    }

    return new Response(
      JSON.stringify({
        attempt_id: attempt.id,
        score,
        total,
        accuracy_percent: Math.round((score / total) * 100),
        results: gradedAnswers,
        assessment,                     // Member 4 (additive)
        mistake_analysis: mistakeAnalysis, // Member 4 (additive)
        agent: agentTrace,              // Study Agent: full Perceive/Analyze/Decide/Act trace
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
}

// Adds CORS headers to every response of handle() and answers the browser's preflight.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const res = await handle(req);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
});
