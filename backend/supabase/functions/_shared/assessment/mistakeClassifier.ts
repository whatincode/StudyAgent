// Member 4 — rule-based mistake classification (no LLM, fully explainable).
// Every result carries a plain-language `reason` that the UI shows to the student.
import type { ErrorType, MistakeAnalysis, MistakeInput } from "./types.ts";

const num = (s: string): number | null => {
  const t = String(s ?? "").trim().replace(/,/g, "");
  if (t === "" || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
};

export function classifyMistake(input: MistakeInput): MistakeAnalysis {
  const { questionId, topic, selectedAnswer, correctAnswer, context: c } = input;
  const done = (errorType: ErrorType, reason: string): MistakeAnalysis => ({ questionId, errorType, reason });

  if (!String(selectedAnswer ?? "").trim()) {
    return done("UNCLASSIFIED", "No answer was selected, so the cause cannot be classified.");
  }

  // 1. Same question already answered wrong before -> the idea has not been learned yet.
  if (c.sameQuestionWrongBefore >= 1 && c.sameQuestionCorrectBefore === 0) {
    return done("KNOWLEDGE_GAP",
      `You have now missed this question ${c.sameQuestionWrongBefore + 1} times without getting it right, so ${topic} needs to be re-learned.`);
  }

  // 2. Both the chosen and the correct answer are numbers -> a calculation slip.
  const a = num(selectedAnswer), b = num(correctAnswer);
  if (a !== null && b !== null) {
    return done("CALCULATION", `You answered ${a} but the correct value is ${b}. Re-check the arithmetic step by step.`);
  }

  const prior = c.topicQuestionsBefore > 0 ? Math.round((c.topicCorrectBefore / c.topicQuestionsBefore) * 100) : null;

  // 3. Usually right in this topic -> probably a slip, not a misunderstanding.
  if (prior !== null && c.topicQuestionsBefore >= 5 && prior >= 70) {
    return done("CARELESS", `You normally get ${prior}% right in ${topic}, so this looks like a slip. Read the options again before answering.`);
  }

  // 4. Weak track record in this topic -> a broader gap.
  if (prior !== null && c.topicQuestionsBefore >= 5 && prior < 40) {
    return done("KNOWLEDGE_GAP", `Your earlier accuracy in ${topic} is only ${prior}%, so this points to a wider gap in the topic.`);
  }

  // 5. Otherwise: the concept itself was misunderstood.
  return done("CONCEPTUAL", `The chosen answer shows a misunderstanding of a ${topic} concept. Review the explanation for this idea.`);
}
