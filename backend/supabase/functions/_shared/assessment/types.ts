// Member 4 — shared types for the assessment / analytics engines.
export type Difficulty = "easy" | "medium" | "hard";
export type ErrorType = "CONCEPTUAL" | "CALCULATION" | "CARELESS" | "KNOWLEDGE_GAP" | "UNCLASSIFIED";
export type Trend = "improving" | "declining" | "stable" | "insufficient_data";
export type GapStatus = "knowledge_gap" | "needs_practice" | "improving" | "strong" | "insufficient_data";

/** One finished quiz attempt (a row of quiz_attempts joined with its quiz). */
export interface AttemptRecord {
  id: string;
  quizId: string;
  topic: string;
  difficulty: Difficulty;
  score: number; // correct answers
  total: number; // questions answered
  completedAt: string;
}

/** One row of the mistakes table. */
export interface MistakeRecord {
  topic: string;
  errorType: ErrorType;
  count: number;
  date: string | null;
}

export interface MistakeContext {
  topicQuestionsBefore: number;
  topicCorrectBefore: number;
  sameQuestionCorrectBefore: number;
  sameQuestionWrongBefore: number;
}
export interface MistakeInput {
  questionId: string;
  topic: string;
  selectedAnswer: string;
  correctAnswer: string;
  context: MistakeContext;
}
export interface MistakeAnalysis {
  questionId: string;
  errorType: ErrorType;
  reason: string;
}

export interface GradedItem {
  questionId: string;
  topic: string;
  difficulty: Difficulty;
  correct: boolean;
  selectedAnswer: string;
}
export interface AttemptAssessment {
  total: number;
  correct: number;
  incorrect: number;
  accuracy: number;
  topicPerformance: { topic: string; total: number; correct: number; accuracy: number }[];
  difficultyPerformance: Record<Difficulty, number | null>;
}

export interface TopicPerformance {
  topic: string;
  accuracy: number;
  correct: number;
  incorrect: number;
  attempts: number; // questions answered
  quizzes: number; // quiz attempts
  trend: Trend;
}
export interface AttemptSummary {
  attemptId: string;
  topic: string;
  difficulty: Difficulty;
  score: number;
  total: number;
  accuracy: number;
  completedAt: string;
}
export interface RecentPerformance {
  recentAccuracy: number | null;
  previousAccuracy: number | null;
  change: number | null;
  direction: Trend;
  attemptIds: string[];
}
export interface Analytics {
  overallAccuracy: number | null;
  totalQuestions: number;
  totalCorrect: number;
  totalIncorrect: number;
  quizzesTaken: number;
  recentPerformance: RecentPerformance;
  attemptHistory: AttemptSummary[];
  topicPerformance: TopicPerformance[];
  difficultyPerformance: Record<Difficulty, number | null>;
}

export interface KnowledgeGap {
  topic: string;
  status: GapStatus;
  accuracy: number;
  attempts: number;
  mistakes: number;
  severity: "high" | "medium" | "low" | "none";
  trend: Trend;
}

export interface StudentEvidenceItem {
  claim: string;
  source: string;
  metric: string;
  topic?: string;
  value: number | string | null;
}
export interface StudentEvidenceBundle {
  studentId: string;
  generatedAt: string;
  mistakes: { topic: string; type: ErrorType; count: number }[];
  evidence: StudentEvidenceItem[];
}
