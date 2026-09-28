// =====================================================================
// Edge Function: generate-flashcards
//
// Topic-to-flashcards: the student types any topic, the LLM writes N
// question/answer pairs, and each is inserted straight into
// `flashcards` (08_flashcards.sql) with the standard SM-2 defaults
// (ease_factor 2.5, interval 0, due today) and source='ai_generated' —
// so they show up in the normal spaced-repetition review queue
// immediately, no separate "AI flashcards" view needed.
//
// Deploy:  supabase functions deploy generate-flashcards
// Call:    POST /functions/v1/generate-flashcards   (Authorization: Bearer <user token>)
//          { "topic": "The water cycle", "count": 8 }
// Returns: { created, topic }
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS, json, resolveStudent } from "../_shared/xai/evidence.ts";
import { callLLM, pickProvider, tryParseJSON } from "../_shared/agent/llm.ts";

interface GenCard { question: string; answer: string; explanation?: string }

function isValidCard(c: unknown): c is GenCard {
  if (!c || typeof c !== "object") return false;
  const g = c as Record<string, unknown>;
  return typeof g.question === "string" && g.question.trim().length > 0 &&
    typeof g.answer === "string" && g.answer.trim().length > 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const provider = pickProvider();
    if (!provider) return json({ error: "Flashcard generation is not configured: set one of the GROQ_API_KEY / GEMINI_API_KEY / ANTHROPIC_API_KEY secrets." }, 503);

    const who = await resolveStudent(req, createClient);
    if ("error" in who) return json({ error: who.error }, who.status);

    const body = await req.json().catch(() => ({}));
    const topic = String(body.topic ?? "").trim().slice(0, 120);
    if (!topic) return json({ error: "topic is required" }, 400);
    const count = Math.min(15, Math.max(3, Number(body.count) || 8));

    const system = [
      `You write spaced-repetition flashcards for a study app. Topic: "${topic}".`,
      `Write exactly ${count} flashcards. Each card tests ONE atomic fact — keep the question short and the answer concise (1-2 sentences max).`,
      "Don't repeat the same fact twice in different wording.",
      'Respond with ONLY this JSON shape, nothing else: {"cards": [{"question": string, "answer": string, "explanation": string}]}',
    ].join("\n\n");

    const text = await callLLM(provider, system, [{ role: "user", content: `Write the flashcards on "${topic}".` }], { maxTokens: 1400, temperature: 0.6, jsonMode: true });
    const parsed = tryParseJSON<{ cards: unknown[] }>(text);
    const valid = (parsed?.cards ?? []).filter(isValidCard);
    if (valid.length === 0) return json({ error: "The AI couldn't produce usable flashcards for that topic — try rephrasing it or try again." }, 502);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const rows = valid.map((c) => ({
      student_id: who.studentId, topic, question: c.question, answer: c.answer,
      explanation: c.explanation ?? null, source: "ai_generated",
    }));
    const { error } = await admin.from("flashcards").insert(rows);
    if (error) return json({ error: error.message }, 500);

    return json({ created: rows.length, topic });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
