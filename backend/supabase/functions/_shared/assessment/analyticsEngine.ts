// Member 4 — analytics pipeline: attempts -> accuracy trend, topic weightage, difficulty split.
import type { Analytics, AttemptRecord, Difficulty, RecentPerformance, Trend } from "./types.ts";

const RECENT_WINDOW = 3; // "recent" = the last 3 quizzes, compared with the 3 before them
const HISTORY_LIMIT = 10;
const TREND_DELTA = 5; // percentage points that count as a real change

const pct = (c: number, t: number) => (t > 0 ? Math.round((c / t) * 100) : 0);
const pooled = (rs: AttemptRecord[]) => {
  const t = rs.reduce((s, r) => s + r.total, 0);
  return t > 0 ? pct(rs.reduce((s, r) => s + r.score, 0), t) : null;
};
const direction = (delta: number | null): Trend =>
  delta === null ? "insufficient_data" : delta >= TREND_DELTA ? "improving" : delta <= -TREND_DELTA ? "declining" : "stable";

/** Trend inside one topic: first half of its attempts vs second half. */
function topicTrend(rs: AttemptRecord[]): Trend {
  if (rs.length < 2) return "insufficient_data";
  const mid = Math.floor(rs.length / 2);
  const a = pooled(rs.slice(0, mid)), b = pooled(rs.slice(mid));
  return a === null || b === null ? "insufficient_data" : direction(b - a);
}

export function computeAnalytics(attempts: AttemptRecord[]): Analytics {
  const rs = attempts.slice().sort((a, b) => +new Date(a.completedAt) - +new Date(b.completedAt));
  const totalQuestions = rs.reduce((s, r) => s + r.total, 0);
  const totalCorrect = rs.reduce((s, r) => s + r.score, 0);

  const recent = rs.slice(-RECENT_WINDOW);
  const previous = rs.slice(-2 * RECENT_WINDOW, -RECENT_WINDOW);
  const recentAccuracy = pooled(recent), previousAccuracy = pooled(previous);
  const change = recentAccuracy !== null && previousAccuracy !== null ? recentAccuracy - previousAccuracy : null;
  const recentPerformance: RecentPerformance = {
    recentAccuracy, previousAccuracy, change, direction: direction(change), attemptIds: recent.map((r) => r.id),
  };

  const topics = new Map<string, AttemptRecord[]>();
  for (const r of rs) topics.set(r.topic, [...(topics.get(r.topic) ?? []), r]);
  const topicPerformance = [...topics.entries()].map(([topic, list]) => {
    const attemptsQ = list.reduce((s, r) => s + r.total, 0), correct = list.reduce((s, r) => s + r.score, 0);
    return {
      topic, accuracy: pct(correct, attemptsQ), correct, incorrect: attemptsQ - correct,
      attempts: attemptsQ, quizzes: list.length, trend: topicTrend(list),
    };
  }).sort((a, b) => a.accuracy - b.accuracy || a.topic.localeCompare(b.topic)); // weakest first

  const diff = (d: Difficulty) => pooled(rs.filter((r) => r.difficulty === d));

  return {
    overallAccuracy: totalQuestions ? pct(totalCorrect, totalQuestions) : null,
    totalQuestions,
    totalCorrect,
    totalIncorrect: totalQuestions - totalCorrect,
    quizzesTaken: rs.length,
    recentPerformance,
    attemptHistory: rs.slice().reverse().slice(0, HISTORY_LIMIT).map((r) => ({
      attemptId: r.id, topic: r.topic, difficulty: r.difficulty, score: r.score, total: r.total,
      accuracy: pct(r.score, r.total), completedAt: r.completedAt,
    })), // newest first
    topicPerformance,
    difficultyPerformance: { easy: diff("easy"), medium: diff("medium"), hard: diff("hard") },
  };
}
