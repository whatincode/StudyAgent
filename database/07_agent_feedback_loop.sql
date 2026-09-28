-- =====================================================================
-- 07 — Agent outcome feedback loop
--
-- Adds the columns runAgentCycle() needs to close the loop: it now
-- records the topic's accuracy at the moment a recommendation is made
-- (baseline_accuracy), and the NEXT time the agent runs for that
-- student it looks back, measures the same topic's accuracy again
-- (outcome_accuracy), and writes the delta. That delta is what lets
-- future scoring reward topics that are actually improving and keep
-- pushing on ones that aren't — a real (if simple) calibration signal
-- instead of a static formula.
-- =====================================================================

alter table recommendations
    add column if not exists baseline_accuracy numeric,       -- concept accuracy at the moment this rec was created
    add column if not exists outcome_accuracy   numeric,       -- concept accuracy the NEXT time the agent checked
    add column if not exists outcome_delta      numeric,       -- outcome_accuracy - baseline_accuracy (null until checked)
    add column if not exists outcome_checked_at timestamptz;   -- when the agent closed the loop on this rec

create index if not exists idx_recommendations_outcome_pending
    on recommendations(student_id, outcome_checked_at)
    where outcome_checked_at is null;
