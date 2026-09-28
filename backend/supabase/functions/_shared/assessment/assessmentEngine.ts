// Member 4 — data loading + per-attempt assessment.
// deno-lint-ignore-file no-explicit-any
import type { AttemptAssessment, AttemptRecord, Difficulty, ErrorType, GradedItem, MistakeRecord } from "./types.ts";

type Admin = any;

const DIFFS: Difficulty[] = ["easy", "medium", "hard"];

export function normalizeDifficulty(d: unknown): Difficulty {
  const s = String(d ?? "").toLowerCase();
  return (DIFFS as string[]).includes(s) ? (s as Difficulty) : "medium";
}

/** Old code wrote 'conceptual' / 'silly mistake' / 'calculation_error'; new code writes UPPER_CASE. Read both. */
export function normalizeErrorType(t: unknown): ErrorType {
  const s = String(t ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (s === "CONCEPTUAL") return "CONCEPTUAL";
  if (s === "CALCULATION" || s === "CALCULATION_ERROR") return "CALCULATION";
  if (s === "CARELESS" || s === "SILLY_MISTAKE") return "CARELESS";
  if (s === "KNOWLEDGE_GAP") return "KNOWLEDGE_GAP";
  return "UNCLASSIFIED";
}

const chunks = <T>(xs: T[], n = 200): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/** All quiz attempts of one student, oldest first, with the quiz topic + difficulty. */
export async function loadAttemptRecords(admin: Admin, studentId: string): Promise<AttemptRecord[]> {
  const { data: attempts, error } = await admin
    .from("quiz_attempts").select("id,quiz_id,score,total,completed_at")
    .eq("student_id", studentId).order("completed_at", { ascending: true });
  if (error) throw new Error(error.message);
  const rows = attempts ?? [];
  const quizIds = [...new Set<string>(rows.map((a: any) => a.quiz_id))];
  const quizMap = new Map<string, { topic: string; difficulty: Difficulty }>();
  if (quizIds.length) {
    const { data: quizzes, error: qErr } = await admin.from("quizzes").select("id,topic,difficulty").in("id", quizIds);
    if (qErr) throw new Error(qErr.message);
    for (const q of quizzes ?? []) quizMap.set(q.id, { topic: q.topic ?? "Unknown", difficulty: normalizeDifficulty(q.difficulty) });
  }
  return rows.map((a: any) => {
    const q = quizMap.get(a.quiz_id);
    return {
      id: a.id,
      quizId: a.quiz_id,
      topic: q?.topic ?? "Unknown",
      difficulty: q?.difficulty ?? "medium",
      score: Number(a.score ?? 0),
      total: Number(a.total ?? 0),
      completedAt: a.completed_at,
    };
  });
}

export async function loadMistakeRecords(admin: Admin, studentId: string): Promise<MistakeRecord[]> {
  const { data, error } = await admin.from("mistakes").select("topic,error_type,count,date").eq("student_id", studentId);
  if (error) throw new Error(error.message);
  return (data ?? []).map((m: any) => ({
    topic: m.topic ?? "Unknown",
    errorType: normalizeErrorType(m.error_type),
    count: Number(m.count ?? 1),
    date: m.date ?? null,
  }));
}

/** How the student did on the given questions in earlier attempts: question_id -> {correct, wrong}. */
export async function loadQuestionHistory(
  admin: Admin, attemptIds: string[], questionIds: string[],
): Promise<Map<string, { correct: number; wrong: number }>> {
  const out = new Map<string, { correct: number; wrong: number }>();
  if (!attemptIds.length || !questionIds.length) return out;
  for (const ids of chunks(attemptIds)) {
    const { data, error } = await admin.from("answers").select("question_id,correct")
      .in("attempt_id", ids).in("question_id", questionIds);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) {
      const h = out.get(r.question_id) ?? { correct: 0, wrong: 0 };
      if (r.correct) h.correct++; else h.wrong++;
      out.set(r.question_id, h);
    }
  }
  return out;
}

const pct = (c: number, t: number) => (t > 0 ? Math.round((c / t) * 100) : 0);

/** Topic + difficulty breakdown of ONE just-graded attempt (shown on the results screen). */
export function evaluateAttempt(items: GradedItem[]): AttemptAssessment {
  const byTopic = new Map<string, { total: number; correct: number }>();
  const byDiff: Record<Difficulty, { total: number; correct: number }> = {
    easy: { total: 0, correct: 0 }, medium: { total: 0, correct: 0 }, hard: { total: 0, correct: 0 },
  };
  let correct = 0;
  for (const it of items) {
    if (it.correct) correct++;
    const t = byTopic.get(it.topic) ?? { total: 0, correct: 0 };
    t.total++; if (it.correct) t.correct++;
    byTopic.set(it.topic, t);
    byDiff[it.difficulty].total++;
    if (it.correct) byDiff[it.difficulty].correct++;
  }
  const dp = (d: Difficulty) => (byDiff[d].total ? pct(byDiff[d].correct, byDiff[d].total) : null);
  return {
    total: items.length,
    correct,
    incorrect: items.length - correct,
    accuracy: pct(correct, items.length),
    topicPerformance: [...byTopic.entries()].map(([topic, s]) => ({ topic, total: s.total, correct: s.correct, accuracy: pct(s.correct, s.total) })),
    difficultyPerformance: { easy: dp("easy"), medium: dp("medium"), hard: dp("hard") },
  };
}
