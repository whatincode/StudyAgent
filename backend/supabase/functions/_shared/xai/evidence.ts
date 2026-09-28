// =====================================================================
// Member 3 — shared evidence loader for the AI Tutor + recommendation engine.
// Builds the SAME evidence contract as Member 4's `xai-evidence` function
// (evidence_id / metric / value ...) directly from the tables, so Member 3's
// functions do not depend on any other Edge Function being deployed.
// Every number the AI states or stores must trace back to one evidence_id.
// =====================================================================

// deno-lint-ignore no-explicit-any
type Admin = any;

export interface Evidence {
  evidence_id: string;
  metric: string;
  value: number | string;
  [k: string]: unknown;
}
export interface Gap { concept: string; attempts: number; accuracy: number; wrong: number }
export interface StudentEvidence {
  student_id: string;
  summary: { overall_accuracy: number; accuracy_trend: string; weakest_concept: string | null };
  knowledge_gaps: Gap[];
  mistake_topic_frequency: { topic: string; count: number }[];
  mistake_frequency: { error_type: string; count: number }[];
  evidence: Evidence[];
}

export const GAP_THRESHOLD = 70; // concept accuracy below this = knowledge gap (same as xai-evidence)

function trend(values: number[]): string {
  if (values.length < 2) return "insufficient_data";
  const split = Math.ceil(values.length / 2);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
  const delta = avg(values.slice(split)) - avg(values.slice(0, split));
  return delta >= 5 ? "improving" : delta <= -5 ? "declining" : "stable";
}

export async function loadStudentEvidence(admin: Admin, studentId: string): Promise<StudentEvidence> {
  const { data: attempts, error: aErr } = await admin
    .from("quiz_attempts").select("id,quiz_id,score,total,completed_at")
    .eq("student_id", studentId).order("completed_at", { ascending: true });
  if (aErr) throw new Error(aErr.message);
  const att = attempts ?? [];
  const attemptIds = att.map((a: { id: string }) => a.id);
  const quizIds = [...new Set(att.map((a: { quiz_id: string }) => a.quiz_id))];

  const { data: quizzes } = quizIds.length
    ? await admin.from("quizzes").select("id,topic").in("id", quizIds) : { data: [] };
  const quizTopic = new Map<string, string>((quizzes ?? []).map((q: { id: string; topic: string }) => [q.id, q.topic]));

  const { data: ans } = attemptIds.length
    ? await admin.from("answers").select("attempt_id,question_id,correct").in("attempt_id", attemptIds)
    : { data: [] };
  const answers = ans ?? [];
  const questionIds = [...new Set(answers.map((a: { question_id: string }) => a.question_id))];

  // `concept` only exists after Database/06_member4_assessment.sql; fall back to the quiz topic without it.
  const qToConcept = new Map<string, string>();
  if (questionIds.length) {
    let res = await admin.from("questions").select("id,quiz_id,concept").in("id", questionIds);
    if (res.error) res = await admin.from("questions").select("id,quiz_id").in("id", questionIds);
    for (const q of res.data ?? []) {
      qToConcept.set(q.id, q.concept ?? quizTopic.get(q.quiz_id) ?? "Unknown");
    }
  }
  const attemptTopic = new Map<string, string>(
    att.map((a: { id: string; quiz_id: string }) => [a.id, quizTopic.get(a.quiz_id) ?? "Unknown"]),
  );

  const { data: mistakes, error: mErr } = await admin
    .from("mistakes").select("topic,error_type,count").eq("student_id", studentId);
  if (mErr) throw new Error(mErr.message);

  const history = att.map((a: { id: string; quiz_id: string; score: number; total: number; completed_at: string }) => ({
    attempt_id: a.id,
    topic: quizTopic.get(a.quiz_id) ?? "Unknown",
    completed_at: a.completed_at,
    accuracy: Number(a.total) > 0 ? Math.round((Number(a.score) / Number(a.total)) * 100) : 0,
  }));
  const recent = history.slice(-5);

  const stats = new Map<string, { total: number; correct: number }>();
  for (const a of answers) {
    const c = qToConcept.get(a.question_id) ?? attemptTopic.get(a.attempt_id) ?? "Unknown";
    const s = stats.get(c) ?? { total: 0, correct: 0 };
    s.total++;
    if (a.correct) s.correct++;
    stats.set(c, s);
  }
  const gaps: Gap[] = [...stats.entries()]
    .map(([concept, s]) => ({ concept, attempts: s.total, wrong: s.total - s.correct, accuracy: s.total ? Math.round((s.correct / s.total) * 100) : 0 }))
    .filter((g) => g.accuracy < GAP_THRESHOLD)
    .sort((a, b) => a.accuracy - b.accuracy);

  const byType = new Map<string, number>(), byTopic = new Map<string, number>();
  for (const m of mistakes ?? []) {
    const n = Number(m.count ?? 1);
    const t = m.error_type ?? "unknown";
    byType.set(t, (byType.get(t) ?? 0) + n);
    byTopic.set(m.topic, (byTopic.get(m.topic) ?? 0) + n);
  }

  const totC = att.reduce((s: number, a: { score: number }) => s + Number(a.score ?? 0), 0);
  const totQ = att.reduce((s: number, a: { total: number }) => s + Number(a.total ?? 0), 0);
  const accTrend = trend(recent.map((x: { accuracy: number }) => x.accuracy));

  const evidence: Evidence[] = [{
    evidence_id: "accuracy_trend:last_5_attempts", metric: "accuracy_trend", value: accTrend,
    period: "last_5_attempts", supporting_attempt_ids: recent.map((x: { attempt_id: string }) => x.attempt_id),
  }];
  for (const g of gaps.slice(0, 5)) {
    evidence.push({
      evidence_id: `knowledge_gap:${g.concept}`, metric: "concept_accuracy", concept: g.concept,
      value: g.accuracy, unit: "percent", attempts: g.attempts, wrong_answers: g.wrong,
    });
  }
  for (const [type, count] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    evidence.push({ evidence_id: `mistake_frequency:${type}`, metric: "mistake_frequency", error_type: type, value: count, unit: "mistakes" });
  }
  for (const [topic, count] of [...byTopic.entries()].sort((a, b) => b[1] - a[1])) {
    evidence.push({ evidence_id: `mistake_topic:${topic}`, metric: "mistakes_in_topic", topic, value: count, unit: "mistakes" });
  }

  return {
    student_id: studentId,
    summary: {
      overall_accuracy: totQ ? Math.round((totC / totQ) * 100) : 0,
      accuracy_trend: accTrend,
      weakest_concept: gaps[0]?.concept ?? null,
    },
    knowledge_gaps: gaps,
    mistake_topic_frequency: [...byTopic.entries()].map(([topic, count]) => ({ topic, count })),
    mistake_frequency: [...byType.entries()].map(([error_type, count]) => ({ error_type, count })),
    evidence,
  };
}

// Who is calling? A signed-in student (their own data only) or Member 3's server code (x-internal-key + student_id).
export async function resolveStudent(
  req: Request,
  // deno-lint-ignore no-explicit-any
  createClient: any,
): Promise<{ studentId: string } | { error: string; status: number }> {
  const internalKey = req.headers.get("x-internal-key");
  if (internalKey) {
    if (internalKey !== Deno.env.get("INTERNAL_API_KEY")) return { error: "Unauthorized", status: 401 };
    const id = new URL(req.url).searchParams.get("student_id");
    if (!id) return { error: "student_id query param is required with x-internal-key", status: 400 };
    return { studentId: id };
  }
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) return { error: "Not authenticated", status: 401 };
  return { studentId: user.id };
}

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
