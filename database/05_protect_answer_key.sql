-- =====================================================================
-- 07 — Stop students from reading the quiz answer key directly.
-- Problem: RLS on `questions` lets every signed-in user SELECT the whole
-- row, including `answer`, straight from the browser (network tab / supabase-js).
-- Fix: column-level privileges. Students can still read the question text and
-- options; `answer`, `explanation` and `error_category` are only readable by the
-- Edge Functions (service role bypasses these grants).
-- Run AFTER 03_question_metadata.sql and 04_seed_content.sql (needs the concept/difficulty columns).
-- The frontend never queries `questions` directly (it uses get-quiz), so nothing breaks.
-- =====================================================================
revoke select on public.questions from anon, authenticated;
grant select (id, quiz_id, question, options, concept, difficulty, created_at)
    on public.questions to authenticated;
