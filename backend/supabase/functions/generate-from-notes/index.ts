// =====================================================================
// Edge Function: generate-from-notes
//
// Upload-to-quiz: the student pastes their own notes (or text
// extracted client-side from a PDF via pdf.js — this function only
// ever sees plain text, never a binary file), and the LLM is
// instructed to build a quiz and/or flashcards GROUNDED ONLY in that
// text — no outside facts. The raw text is also saved to
// `study_materials` (09_ai_generated_content.sql) so it can be reused
// later without re-pasting it.
//
// Deploy:  supabase functions deploy generate-from-notes
// Call:    POST /functions/v1/generate-from-notes   (Authorization: Bearer <user token>)
//          { "notes": "...", "make": "both"|"quiz"|"cards", "count": 8 }
// Returns: { quiz_id, flashcards_created, topic_label }
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS, json, resolveStudent } from "../_shared/xai/evidence.ts";
import { callLLM, pickProvider, tryParseJSON } from "../_shared/agent/llm.ts";

interface GenQuestion { question: string; options: string[]; answer: string; difficulty: "easy" | "medium" | "hard" }
interface GenCard { question: string; answer: string }
interface NotesResult { topic_label: string; quiz: unknown[]; cards: unknown[] }

function isValidQuestion(q: unknown): q is GenQuestion {
  if (!q || typeof q !== "object") return false;
  const g = q as Record<string, unknown>;
  return typeof g.question === "string" && g.question.trim().length > 0 &&
    Array.isArray(g.options) && g.options.length >= 2 && g.options.length <= 6 &&
    g.options.every((o) => typeof o === "string" && o.trim()) &&
    typeof g.answer === "string" && g.options.includes(g.answer) &&
    ["easy", "medium", "hard"].includes(String(g.difficulty));
}
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
    if (!provider) return json({ error: "Generation from notes is not configured: set one of the GROQ_API_KEY / GEMINI_API_KEY / ANTHROPIC_API_KEY secrets." }, 503);

    const who = await resolveStudent(req, createClient);
    if ("error" in who) return json({ error: who.error }, who.status);

    const body = await req.json().catch(() => ({}));
    const notes = String(body.notes ?? "").trim().slice(0, 12000); // bounded so one paste can't blow the token budget
    if (notes.length < 40) return json({ error: "Paste at least a few sentences of notes first." }, 400);
    const make = ["quiz", "cards", "both"].includes(body.make) ? body.make : "both";
    const count = Math.min(10, Math.max(3, Number(body.count) || 8));

    const system = [
      "You turn a student's own notes into study material. You do NOT add facts that aren't in the notes below.",
      `Notes:\n"""\n${notes}\n"""`,
      "First, come up with a short topic label (3-6 words) that describes what these notes are about.",
      make !== "cards" ? `Then write up to ${count} multiple-choice questions grounded ONLY in the notes above, each with exactly 4 options and one correct answer, spread across easy/medium/hard difficulty.` : "Do not write any quiz questions.",
      make !== "quiz" ? `Then write up to ${count} flashcards (question/answer pairs) covering the key facts in the notes.` : "Do not write any flashcards.",
      'Respond with ONLY this JSON shape, nothing else: {"topic_label": string, "quiz": [{"question": string, "options": [string,string,string,string], "answer": string, "difficulty": "easy"|"medium"|"hard"}], "cards": [{"question": string, "answer": string}]}',
    ].join("\n\n");

    const text = await callLLM(provider, system, [{ role: "user", content: "Build the study material from these notes." }], { maxTokens: 2000, temperature: 0.4, jsonMode: true });
    const parsed = tryParseJSON<NotesResult>(text);
    if (!parsed || typeof parsed.topic_label !== "string") return json({ error: "The AI couldn't extract usable content from those notes — try adding more detail." }, 502);

    const topicLabel = parsed.topic_label.trim().slice(0, 120) || "From your notes";
    const validQuestions = (parsed.quiz ?? []).filter(isValidQuestion);
    const validCards = (parsed.cards ?? []).filter(isValidCard);
    if (validQuestions.length === 0 && validCards.length === 0) {
      return json({ error: "The AI couldn't extract usable content from those notes — try adding more detail." }, 502);
    }

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    await admin.from("study_materials").insert({ student_id: who.studentId, topic_label: topicLabel, raw_text: notes });

    let quizId: string | null = null;
    if (validQuestions.length >= 2) {
      const { data: quiz, error: quizErr } = await admin.from("quizzes")
        .insert({ topic: topicLabel, difficulty: "medium", source: "from_notes" }).select().single();
      if (!quizErr && quiz) {
        quizId = quiz.id;
        await admin.from("questions").insert(validQuestions.map((q) => ({
          quiz_id: quiz.id, question: q.question, options: q.options, answer: q.answer,
          concept: topicLabel, difficulty: q.difficulty,
        })));
      }
    }

    let flashcardsCreated = 0;
    if (validCards.length > 0) {
      const rows = validCards.map((c) => ({
        student_id: who.studentId, topic: topicLabel, question: c.question, answer: c.answer, source: "from_notes",
      }));
      const { error: fcErr } = await admin.from("flashcards").insert(rows);
      if (!fcErr) flashcardsCreated = rows.length;
    }

    return json({ quiz_id: quizId, flashcards_created: flashcardsCreated, topic_label: topicLabel });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
