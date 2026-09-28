// =====================================================================
// The Study Agent — Perceive / Analyze / Decide / Act, made explicit.
//
// v2: the rule-based scorer in analyze() is now a FLOOR, not the whole
// decision. Three things changed from the original version:
//
//   1. DECIDE lets the LLM see the top-N scored candidates (never the
//      full unfiltered topic list — it can't invent a topic that
//      isn't already an evidence-backed gap) and propose which one to
//      act on, with reasoning and a plan tailored to *this* student's
//      mistakes. If the LLM is unavailable, disagrees in an invalid
//      way, or its topic isn't one of the candidates, we fall back to
//      the plain rule-based top pick — so the agent degrades to v1
//      behaviour rather than breaking.
//
//   2. FEEDBACK — before scoring anything, the agent looks at its own
//      past recommendations for this student that haven't been
//      checked yet, measures whether that topic's accuracy actually
//      moved, and writes the outcome back. That outcome then nudges
//      this run's scoring: topics that improved get deprioritised
//      (it's working), topics that didn't move get a small bump.
//      This is the actual "did I help" signal the v1 agent lacked.
//
//   3. ANTI-REPEAT — if the top candidate is the exact same topic the
//      agent just recommended last run AND that run showed no
//      improvement, and a second candidate is close behind, the agent
//      switches to the second one instead of hammering the same
//      concept a third time in a row (diminishing returns / spaced
//      interleaving), and says so in the trace.
//
// Call `runAgentCycle(admin, studentId, trigger)` from any Edge Function
// that has service-role access. It writes a `recommendations` row and an
// `agent_runs` row, and returns the full trace so the caller (e.g.
// submit-quiz-attempt, or the agent-cycle endpoint itself) can hand it
// straight back to the frontend.
// =====================================================================

// deno-lint-ignore no-explicit-any
type Admin = any;

import { loadStudentEvidence, type Gap } from "../xai/evidence.ts";
import { callLLM, pickProvider, tryParseJSON } from "./llm.ts";

const TARGET_ACCURACY = 85; // mastery goal used in the decide-stage explanation text
const TOP_N = 3;            // how many candidates the LLM is allowed to choose between
const IMPROVED_DELTA = 8;   // outcome_delta >= this = "the last recommendation worked"
const STALLED_DELTA = 0;    // outcome_delta <= this = "no measurable movement"
const CLOSE_ENOUGH = 0.15;  // score gap within which the 2nd candidate is a fair swap-in

export interface TopicScore {
  topic: string;
  accuracy: number;
  attempts: number;
  wrong: number;
  status: "knowledge_gap" | "on_track";
  score: number;                 // 0..1, higher = more urgent (rule-based floor)
  factors: { factor: string; value: number | string; weight: number; evidence_id: string }[];
}

export interface AgentTrace {
  trigger: string;
  perceived: {
    overall_accuracy: number;
    accuracy_trend: string;
    weakest_concept: string | null;
    gaps_considered: number;
  };
  feedback: { topic: string; baseline_accuracy: number; outcome_accuracy: number; delta: number }[];
  analysis: TopicScore[];
  decision: {
    topic: string;
    priority: "low" | "medium" | "high";
    confidence: number;          // 0..100
    reason: string;
    factors: TopicScore["factors"];
    source: "llm" | "rule_based"; // was this topic chosen by the LLM's judgement or the formula floor?
    alternates: string[];         // other candidates the agent considered and didn't pick
  } | null;
  action: { recommendation_id: string | null; wrote: string; plan: string[]; plan_source: "llm" | "template" } | null;
  agent_run_id: string | null;
  log: { step: "PERCEIVE" | "ANALYZE" | "FEEDBACK" | "DECIDE" | "ACT"; text: string }[];
}

/** ANALYZE: turn each knowledge gap into a scored, explainable candidate (this is the floor, not the ceiling). */
function analyze(gaps: Gap[], trend: string, multipliers: Map<string, number>): TopicScore[] {
  return gaps.map((g) => {
    const gapSize = Math.max(0, (TARGET_ACCURACY - g.accuracy) / 100);
    const trendWeight = trend === "declining" ? 1 : trend === "stable" ? 0.5 : 0.2;
    const mistakeWeight = Math.min(1, g.wrong / 4);
    const baseScore = gapSize * 0.5 + mistakeWeight * 0.3 + trendWeight * 0.2;
    const mult = multipliers.get(g.concept) ?? 1;
    const score = Math.min(1, baseScore * mult);
    const factors = [
      { factor: "accuracy_gap", value: Number(gapSize.toFixed(2)), weight: 0.5, evidence_id: `knowledge_gap:${g.concept}` },
      { factor: "recent_mistakes", value: g.wrong, weight: 0.3, evidence_id: `knowledge_gap:${g.concept}` },
      { factor: "accuracy_trend", value: trend, weight: 0.2, evidence_id: "accuracy_trend:last_5_attempts" },
    ];
    if (mult !== 1) {
      factors.push({ factor: "outcome_feedback", value: mult > 1 ? "stalled_last_time" : "improving", weight: 0, evidence_id: `feedback:${g.concept}` });
    }
    return {
      topic: g.concept,
      accuracy: g.accuracy,
      attempts: g.attempts,
      wrong: g.wrong,
      status: "knowledge_gap" as const,
      score,
      factors,
    };
  }).sort((a, b) => b.score - a.score);
}

/**
 * FEEDBACK: close the loop on this student's past recommendations. For every recommendation
 * that hasn't been checked yet, see whether the recommended topic's accuracy actually moved
 * since, write the outcome back to `recommendations`, and turn it into a scoring multiplier
 * for this run (topics still failing get a small urgency bump; topics that improved get
 * deprioritised because the plan is visibly working).
 */
async function closeFeedbackLoop(
  admin: Admin,
  studentId: string,
  currentGaps: Gap[],
): Promise<{ multipliers: Map<string, number>; report: AgentTrace["feedback"] }> {
  const multipliers = new Map<string, number>();
  const report: AgentTrace["feedback"] = [];

  const { data: pending } = await admin
    .from("recommendations")
    .select("id,recommended_topic,baseline_accuracy,created_at")
    .eq("student_id", studentId)
    .is("outcome_checked_at", null)
    .not("baseline_accuracy", "is", null)
    .order("created_at", { ascending: false })
    .limit(5);

  const gapByConcept = new Map(currentGaps.map((g) => [g.concept, g]));

  for (const rec of pending ?? []) {
    const topic = String(rec.recommended_topic).replace(/ — Revision$/, "");
    const baseline = Number(rec.baseline_accuracy);
    const stillGap = gapByConcept.get(topic);
    // If the topic no longer shows up as a knowledge gap at all, treat that as mastery
    // (it rose above GAP_THRESHOLD) rather than "no data" — that's the success case.
    const outcomeAccuracy = stillGap ? stillGap.accuracy : Math.max(baseline, TARGET_ACCURACY);
    const delta = Math.round(outcomeAccuracy - baseline);

    await admin.from("recommendations").update({
      outcome_accuracy: outcomeAccuracy,
      outcome_delta: delta,
      outcome_checked_at: new Date().toISOString(),
    }).eq("id", rec.id);

    report.push({ topic, baseline_accuracy: baseline, outcome_accuracy: outcomeAccuracy, delta });

    if (delta >= IMPROVED_DELTA) multipliers.set(topic, 0.6);       // it's working — ease off
    else if (delta <= STALLED_DELTA) multipliers.set(topic, 1.2);   // no movement — push a bit harder
    // small positive-but-not-quite deltas: leave multiplier at 1 (no strong signal either way)
  }

  return { multipliers, report };
}

/**
 * DECIDE (LLM layer): show the LLM only the pre-scored top-N candidates and ask it to pick
 * one, justify it from the evidence, and write a 3-step plan tailored to this student. The
 * rule-based ranking is the floor: if the LLM is down, times out, or returns something that
 * isn't one of the candidate topics, the caller falls back to the plain top rule-based pick.
 */
async function llmDecide(
  candidates: TopicScore[],
  trend: string,
  overallAccuracy: number,
): Promise<{ topic: string; reason: string; confidence_hint: number; plan: string[] } | null> {
  const provider = pickProvider();
  if (!provider || candidates.length === 0) return null;

  const evidenceBlock = candidates.map((c, i) =>
    `${i + 1}. "${c.topic}" — ${c.accuracy}% accuracy over ${c.attempts} question(s), ${c.wrong} wrong, rule_score=${c.score.toFixed(2)}`
  ).join("\n");

  const system = [
    "You are the decision layer of a study-recommendation agent. You do NOT invent facts.",
    `Overall accuracy: ${overallAccuracy}%. Recent trend: ${trend}. Mastery goal: ${TARGET_ACCURACY}%.`,
    "Candidate topics (already filtered to real knowledge gaps, ranked by a rule-based urgency score):",
    evidenceBlock,
    "Pick exactly ONE topic to recommend next — it MUST be copied verbatim from the candidate list above, never a topic that isn't listed.",
    "Write a short reason grounded only in the numbers shown (no invented scores or history).",
    "Write a 3-step study plan tailored to THIS topic and THIS student's mistake count — not a generic template.",
    'Respond with ONLY this JSON shape, nothing else: {"topic": string, "reason": string, "confidence_hint": number (0-100), "plan": [string, string, string]}',
  ].join("\n\n");

  try {
    const text = await callLLM(provider, system, [{ role: "user", content: "Decide." }], { maxTokens: 400, temperature: 0.3, jsonMode: true });
    const parsed = tryParseJSON<{ topic: string; reason: string; confidence_hint: number; plan: string[] }>(text);
    if (!parsed || typeof parsed.topic !== "string") return null;
    if (!candidates.some((c) => c.topic === parsed.topic)) return null; // hallucinated a topic not in evidence — reject
    if (!Array.isArray(parsed.plan) || parsed.plan.length === 0) return null;
    return {
      topic: parsed.topic,
      reason: String(parsed.reason ?? "").slice(0, 400),
      confidence_hint: Number.isFinite(parsed.confidence_hint) ? Math.min(95, Math.max(0, parsed.confidence_hint)) : 50,
      plan: parsed.plan.slice(0, 3).map((s) => String(s).slice(0, 200)),
    };
  } catch {
    return null; // any provider error → silently fall back to rule-based
  }
}

/** DECIDE (rule-based floor): pick the single highest-scoring candidate and justify it in plain language. */
function ruleDecide(scored: TopicScore[]) {
  const top = scored[0];
  if (!top) return null;
  const confidence = Math.round(Math.min(95, Math.max(30, 30 + 35 * Math.min(1, top.attempts / 10) + 30 * Math.min(1, top.score / 0.6))));
  const priority: "low" | "medium" | "high" = top.accuracy < 40 || top.wrong >= 3 ? "high" : top.accuracy < 60 ? "medium" : "low";
  const bits = [
    top.wrong ? `${top.wrong} wrong answer${top.wrong === 1 ? "" : "s"} in ${top.topic}` : `weak results in ${top.topic}`,
    `${top.accuracy}% accuracy over ${top.attempts} question${top.attempts === 1 ? "" : "s"} vs the ${TARGET_ACCURACY}% goal`,
  ];
  if (scored.length > 1) bits.push(`ranked above ${scored.length - 1} other candidate topic${scored.length - 1 === 1 ? "" : "s"}`);
  return { topic: top.topic, priority, confidence, reason: bits.join(", ") + ".", factors: top.factors };
}

export async function runAgentCycle(admin: Admin, studentId: string, trigger: string): Promise<AgentTrace> {
  const log: AgentTrace["log"] = [];

  // ---- PERCEIVE ----
  const ev = await loadStudentEvidence(admin, studentId);
  log.push({
    step: "PERCEIVE",
    text: `loaded evidence for student: ${ev.knowledge_gaps.length} concept(s) below the gap threshold, overall accuracy ${ev.summary.overall_accuracy}%, trend ${ev.summary.accuracy_trend}`,
  });

  // ---- FEEDBACK (close the loop on past recommendations before scoring anything new) ----
  const { multipliers, report: feedback } = await closeFeedbackLoop(admin, studentId, ev.knowledge_gaps);
  log.push({
    step: "FEEDBACK",
    text: feedback.length
      ? feedback.map((f) => `${f.topic}: ${f.baseline_accuracy}% → ${f.outcome_accuracy}% (Δ${f.delta >= 0 ? "+" : ""}${f.delta})`).join("  ·  ")
      : "no past recommendation was due for an outcome check this run",
  });

  // ---- ANALYZE ----
  const scored = analyze(ev.knowledge_gaps, ev.summary.accuracy_trend, multipliers);
  log.push({
    step: "ANALYZE",
    text: scored.length
      ? scored.map((s) => `${s.topic} → score ${s.score.toFixed(2)} (${s.accuracy}% accuracy, ${s.wrong} mistakes)`).join("  ·  ")
      : "no concept currently falls below the gap threshold — nothing to prioritise yet",
  });

  // ---- DECIDE ----
  const candidates = scored.slice(0, TOP_N);
  const ruleTop = ruleDecide(scored);
  let decision: AgentTrace["decision"] = null;
  let planSource: "llm" | "template" = "template";
  let plan: string[] = [];

  if (ruleTop) {
    const llm = await llmDecide(candidates, ev.summary.accuracy_trend, ev.summary.overall_accuracy);
    const chosen = llm ? (scored.find((s) => s.topic === llm.topic) ?? scored[0]) : scored[0];

    // Anti-repeat: if the LLM (or the rule floor) landed back on the same topic that just
    // stalled last cycle, and a close second candidate exists, interleave instead of
    // recommending the identical thing a third time.
    let finalPick = chosen;
    let interleaved = false;
    const stalledSameTopic = multipliers.get(chosen.topic) === 1.2;
    if (stalledSameTopic && scored.length > 1) {
      const runnerUp = scored.find((s) => s.topic !== chosen.topic && (chosen.score - s.score) <= CLOSE_ENOUGH);
      if (runnerUp) { finalPick = runnerUp; interleaved = true; }
    }

    const priority: "low" | "medium" | "high" = finalPick.accuracy < 40 || finalPick.wrong >= 3 ? "high" : finalPick.accuracy < 60 ? "medium" : "low";
    const usedLLM = !!llm && llm.topic === finalPick.topic && !interleaved;
    const ruleConfidence = Math.round(Math.min(95, Math.max(30, 30 + 35 * Math.min(1, finalPick.attempts / 10) + 30 * Math.min(1, finalPick.score / 0.6))));
    const confidence = usedLLM && llm ? Math.round((llm.confidence_hint + ruleConfidence) / 2) : ruleConfidence;

    let reason = usedLLM && llm ? llm.reason : ruleDecide([finalPick])!.reason;
    if (interleaved) reason = `Switched from "${chosen.topic}" (no improvement last cycle) to keep progress moving. ${reason}`;

    decision = {
      topic: finalPick.topic,
      priority,
      confidence,
      reason,
      factors: finalPick.factors,
      source: usedLLM ? "llm" : "rule_based",
      alternates: candidates.filter((c) => c.topic !== finalPick.topic).map((c) => c.topic),
    };

    if (usedLLM && llm) { plan = llm.plan; planSource = "llm"; }

    log.push({
      step: "DECIDE",
      text: `selected "${decision.topic}" via ${decision.source}${interleaved ? " (interleaved away from a stalled topic)" : ""} — priority ${decision.priority}, confidence ${decision.confidence}%`,
    });
  } else {
    log.push({ step: "DECIDE", text: "no decision made — insufficient evidence or no gap found" });
  }

  // ---- ACT ----
  let action: AgentTrace["action"] = null;
  let recId: string | null = null;
  if (decision) {
    const topicScore = scored.find((s) => s.topic === decision!.topic)!;
    if (plan.length === 0) {
      plan = [
        `Short warm-up quiz on ${decision.topic}`,
        "Socratic tutor session on the weakest sub-skill",
        "Re-check accuracy after the next attempt",
      ];
      planSource = "template";
    }
    // Replace this student's still-pending recommendation for the same topic (no duplicates piling up).
    await admin.from("recommendations").delete()
      .eq("student_id", studentId).eq("status", "pending").eq("recommended_topic", `${decision.topic} — Revision`);
    const { data: recRow, error: recErr } = await admin.from("recommendations").insert({
      student_id: studentId,
      recommended_topic: `${decision.topic} — Revision`,
      priority: decision.priority,
      status: "pending",
      reason: decision.reason,
      confidence_score: decision.confidence / 100,
      contributing_factors: decision.factors,
      baseline_accuracy: topicScore.accuracy, // for the next run's FEEDBACK step
    }).select().single();
    if (!recErr && recRow) recId = recRow.id;
    action = { recommendation_id: recId, wrote: `recommendation: ${decision.topic} — Revision`, plan, plan_source: planSource };
    log.push({ step: "ACT", text: `wrote recommendation "${decision.topic} — Revision" and queued a ${plan.length}-step ${planSource} plan` });
  } else {
    log.push({ step: "ACT", text: "nothing written — the agent will re-run after the next quiz attempt" });
  }

  // ---- persist the run itself, so the loop is auditable over time ----
  let agentRunId: string | null = null;
  const { data: runRow, error: runErr } = await admin.from("agent_runs").insert({
    student_id: studentId,
    trigger,
    perceived: ev.summary,
    analysis: scored,
    decision,
    action,
    recommendation_id: recId,
  }).select().single();
  if (!runErr && runRow) agentRunId = runRow.id;

  return {
    trigger,
    perceived: { ...ev.summary, gaps_considered: ev.knowledge_gaps.length },
    feedback,
    analysis: scored,
    decision,
    action,
    agent_run_id: agentRunId,
    log,
  };
}
