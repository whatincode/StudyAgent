-- =====================================================================
-- Question-level metadata, required for concept analysis, adaptive
-- difficulty (get-quiz) and the agent's per-concept scoring.
-- Run AFTER 01_schema.sql and 02_row_level_security.sql.
-- Safe to re-run: every ALTER uses IF NOT EXISTS.
-- =====================================================================

alter table questions add column if not exists concept text;
alter table questions add column if not exists difficulty text;
alter table questions add column if not exists explanation text;
alter table questions add column if not exists error_category text;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'questions_difficulty_check') then
        alter table questions add constraint questions_difficulty_check
            check (difficulty in ('easy','medium','hard'));
    end if;
end $$;

create index if not exists idx_questions_quiz_difficulty on questions(quiz_id, difficulty);
create index if not exists idx_questions_concept on questions(concept);
create index if not exists idx_answers_attempt on answers(attempt_id);
create index if not exists idx_answers_question on answers(question_id);
create index if not exists idx_attempts_student_completed on quiz_attempts(student_id, completed_at desc);
create index if not exists idx_mistakes_student_topic on mistakes(student_id, topic);
