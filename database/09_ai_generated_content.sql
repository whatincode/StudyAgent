-- =====================================================================
-- 09 — AI-generated content: topic-to-quiz, topic-to-flashcards, and
-- upload-to-quiz/flashcards from a student's own notes.
--
-- Adds a `source` column to `quizzes` (mirroring the one `flashcards`
-- already has from 08_flashcards.sql) so a quiz created by
-- generate-quiz / generate-from-notes is distinguishable from the
-- seeded content in 04_seed_content.sql — useful for a teacher/parent
-- view, or just for not confusing "the class quiz" with "a quiz a
-- student generated for themselves".
--
-- Widens the flashcards.source check constraint to also allow
-- 'ai_generated' (from generate-flashcards) and 'from_notes' (from
-- generate-from-notes), alongside the existing 'manual' and
-- 'auto_from_mistake'.
--
-- Adds `study_materials`: an audit trail of notes/PDF text a student
-- pasted or uploaded into the "Create" page, so the same source text
-- can be re-used later (e.g. to generate a second, harder quiz from
-- the same notes) without asking the student to paste it again.
--
-- Run AFTER 01_schema.sql, 02_row_level_security.sql and 08_flashcards.sql.
-- Safe to re-run.
-- =====================================================================

alter table quizzes add column if not exists source text default 'seed';
do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'quizzes_source_check') then
        alter table quizzes add constraint quizzes_source_check
            check (source in ('seed','ai_generated','from_notes'));
    end if;
end $$;

alter table flashcards drop constraint if exists flashcards_source_check;
alter table flashcards add constraint flashcards_source_check
    check (source in ('manual','auto_from_mistake','ai_generated','from_notes'));

create table if not exists study_materials (
    id          uuid primary key default uuid_generate_v4(),
    student_id  uuid references profiles(id) on delete cascade,
    topic_label text,
    raw_text    text not null,
    created_at  timestamptz default now()
);

create index if not exists idx_study_materials_student on study_materials(student_id, created_at desc);

alter table study_materials enable row level security;

create policy "Students can view their own study materials"
    on study_materials for select using (auth.uid() = student_id);

create policy "Students can insert their own study materials"
    on study_materials for insert with check (auth.uid() = student_id);
