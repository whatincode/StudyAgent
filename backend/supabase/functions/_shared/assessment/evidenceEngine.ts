// Member 4 — structured, citable evidence: every claim names the table it came from.
import type { Analytics, KnowledgeGap, MistakeRecord, StudentEvidenceBundle, StudentEvidenceItem } from "./types.ts";

export function buildStudentEvidence(args: {
  studentId: string; analytics: Analytics; knowledgeGaps: KnowledgeGap[]; mistakes: MistakeRecord[];
}): StudentEvidenceBundle {
  const { studentId, analytics, knowledgeGaps, mistakes } = args;

  const agg = new Map<string, { topic: string; type: MistakeRecord["errorType"]; count: number }>();
  for (const m of mistakes) {
    const k = `${m.topic}|${m.errorType}`;
    const cur = agg.get(k) ?? { topic: m.topic, type: m.errorType, count: 0 };
    cur.count += m.count;
    agg.set(k, cur);
  }
  const mistakeRows = [...agg.values()].sort((a, b) => b.count - a.count);

  const evidence: StudentEvidenceItem[] = [];
  for (const g of knowledgeGaps.filter((x) => x.status === "knowledge_gap" || x.status === "needs_practice").slice(0, 5)) {
    evidence.push({
      claim: `${g.accuracy}% accuracy in ${g.topic} across ${g.attempts} questions`,
      source: "quiz_attempts", metric: "topic_accuracy", topic: g.topic, value: g.accuracy,
    });
  }
  for (const m of mistakeRows.slice(0, 5)) {
    evidence.push({
      claim: `${m.count} ${m.type.toLowerCase().replace("_", " ")} mistake${m.count === 1 ? "" : "s"} in ${m.topic}`,
      source: "mistakes", metric: "mistake_count", topic: m.topic, value: m.count,
    });
  }
  const rp = analytics.recentPerformance;
  if (rp.recentAccuracy !== null && rp.previousAccuracy !== null && rp.change !== null) {
    evidence.push({
      claim: `Recent accuracy ${rp.recentAccuracy}% vs ${rp.previousAccuracy}% before (${rp.change >= 0 ? "+" : ""}${rp.change} points, ${rp.direction})`,
      source: "quiz_attempts", metric: "accuracy_trend", value: rp.direction,
    });
  }
  return { studentId, generatedAt: new Date().toISOString(), mistakes: mistakeRows, evidence };
}
