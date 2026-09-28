// Member 4 — knowledge-gap map: one status per topic, with a severity for prioritising.
import type { GapStatus, KnowledgeGap, TopicPerformance } from "./types.ts";

export const MIN_QUESTIONS = 3; // fewer answers than this is not enough evidence to judge a topic

export function gapStatus(accuracy: number, attempts: number): GapStatus {
  if (attempts < MIN_QUESTIONS) return "insufficient_data";
  if (accuracy < 50) return "knowledge_gap";
  if (accuracy < 70) return "needs_practice";
  if (accuracy < 85) return "improving"; // solid, not yet mastered
  return "strong";
}

export function buildKnowledgeGapMap(topics: TopicPerformance[]): KnowledgeGap[] {
  return topics.map((t) => {
    const status = gapStatus(t.accuracy, t.attempts);
    const severity = status === "knowledge_gap" ? (t.accuracy < 40 ? "high" : "medium")
      : status === "needs_practice" ? "low" : "none";
    return { topic: t.topic, status, accuracy: t.accuracy, attempts: t.attempts, mistakes: t.incorrect, severity, trend: t.trend } as KnowledgeGap;
  }).sort((a, b) => a.accuracy - b.accuracy);
}
