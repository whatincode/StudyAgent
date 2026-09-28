// =====================================================================
// Edge Function: generate-quiz
//
// Topic-to-quiz: the student types any topic, the LLM writes N
// multiple-choice questions with difficulty tags, and they're stored
// exactly like a seeded quiz (04_seed_content.sql) — same `quizzes` /
// `questions` tables, same column-level answer protection from
// 05_protect_answer_key.sql, same get-quiz adaptive-difficulty flow.
// The frontend never sees the answer key directly: it gets back a
// quiz_id and calls the existing get-quiz function to fetch it, same
// as any other quiz.
//
// Uses the same LLM provider already wired up for ai-tutor and the
// agent orchestrator (see _shared/agent/llm.ts) — set one of
// GROQ_API_KEY / GEMINI_API_KEY / ANTHROPIC_API_KEY to enable this.
//
// Deploy:  supabase functions deploy generate-quiz
// Call:    POST /functions/v1/generate-quiz   (Authorization: Bearer <user token>)
//          { "topic": "Photosynthesis", "count": 8 }
// Returns: { quiz_id, topic, count }
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS, json, resolveStudent } from "../_shared/xai/evidence.ts";
import { callLLM, pickProvider, tryParseJSON } from "../_shared/agent/llm.ts";

interface GenQuestion {
  question: string;
  options: string[];
  answer: string;
  difficulty: "easy" | "medium" | "hard";
  explanation?: string;
}

function isValidQuestion(q: unknown): q is GenQuestion {
  if (!q || typeof q !== "object") return false;
  const g = q as Record<string, unknown>;
  if (typeof g.question !== "string" || !g.question.trim()) return false;
  if (!Array.isArray(g.options) || g.options.length < 2 || g.options.length > 6) return false;
  if (!g.options.every((o) => typeof o === "string" && o.trim())) return false;
  if (typeof g.answer !== "string" || !g.options.includes(g.answer)) return false;
  if (!["easy", "medium", "hard"].includes(String(g.difficulty))) return false;
  return true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const provider = pickProvider();
    if (!provider) return json({ error: "Quiz generation is not configured: set one of the GROQ_API_KEY / GEMINI_API_KEY / ANTHROPIC_API_KEY secrets." }, 503);

    const who = await resolveStudent(req, createClient);
    if ("error" in who) return json({ error: who.error }, who.status);

    const body = await req.json().catch(() => ({}));
    const topic = String(body.topic ?? "").trim().slice(0, 120);
    if (!topic) return json({ error: "topic is required" }, 400);
    const count = Math.min(12, Math.max(3, Number(body.count) || 8));

    const system = [
      `You write quiz questions for a study app. Topic: "${topic}".`,
      `Write exactly ${count} multiple-choice questions, spread roughly evenly across easy/medium/hard difficulty.`,
      "Each question needs exactly 4 plausible options, one of which is correct, and a one-sentence explanation of the correct answer.",
      "Do not invent trick questions or ambiguous wording. Keep each question self-contained (no \"see above\").",
      'Respond with ONLY this JSON shape, nothing else: {"questions": [{"question": string, "options": [string,string,string,string], "answer": string (must exactly match one option), "difficulty": "easy"|"medium"|"hard", "explanation": string}]}',
    ].join("\n\n");

    const text = await callLLM(provider, system, [{ role: "user", content: `Write the quiz on "${topic}".` }], { maxTokens: 1800, temperature: 0.6, jsonMode: true });
    const parsed = tryParseJSON<{ questions: unknown[] }>(text);
    const valid = (parsed?.questions ?? []).filter(isValidQuestion);
    if (valid.length < 3) return json({ error: "The AI couldn't produce a usable quiz for that topic — try rephrasing it or try again." }, 502);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: quiz, error: quizErr } = await admin.from("quizzes")
      .insert({ topic, difficulty: "medium", source: "ai_generated" }).select().single();
    if (quizErr || !quiz) return json({ error: quizErr?.message ?? "Could not create the quiz." }, 500);

    const rows = valid.map((q) => ({
      quiz_id: quiz.id, question: q.question, options: q.options, answer: q.answer,
      concept: topic, difficulty: q.difficulty, explanation: q.explanation ?? null,
    }));
    const { error: qErr } = await admin.from("questions").insert(rows);
    if (qErr) return json({ error: qErr.message }, 500);

    return json({ quiz_id: quiz.id, topic, count: rows.length });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
