-- =====================================================================
-- 08 — Flashcards (SM-2 spaced repetition)
--
-- One row per flashcard. Cards are created two ways:
--   1. Manually (a student adds one themselves) — source = 'manual'
--   2. Automatically, when the same question is answered incorrectly
--      twice by the same student — source = 'auto_from_mistake'
--      (the frontend's registerWrongAnswer() does this in demo mode;
--      submit-quiz-attempt should do the equivalent server-side once
--      this table is wired into the live quiz-submission flow).
--
-- Scheduling fields follow the standard SM-2 algorithm: ease_factor
-- starts at 2.5 and is nudged by each review's quality score (0=Again,
-- 3=Hard, 4=Good, 5=Easy); interval_days and next_review_date are
-- recomputed on every review.
--
-- Run AFTER 01_schema.sql and 02_row_level_security.sql.
-- =====================================================================

create table if not exists flashcards (
    id                uuid primary key default uuid_generate_v4(),
    student_id        uuid references profiles(id) on delete cascade,
    topic             text not null,
    question          text not null,
    answer            text not null,
    explanation       text,
    source_question_id uuid references questions(id) on delete set null,  -- null for manually-added cards
    ease_factor       numeric default 2.5,
    interval_days     int default 0,
    repetitions       int default 0,
    next_review_date  date default current_date,
    source            text check (source in ('manual','auto_from_mistake')) default 'manual',
    created_at        timestamptz default now(),
    updated_at        timestamptz default now()
);

create index if not exists idx_flashcards_student on flashcards(student_id);
create index if not exists idx_flashcards_due on flashcards(student_id, next_review_date);
-- one auto-generated card per (student, question) — the frontend/edge function should
-- upsert against this instead of inserting a duplicate when the same question is missed again
create unique index if not exists uq_flashcards_auto_per_question
    on flashcards(student_id, source_question_id)
    where source = 'auto_from_mistake' and source_question_id is not null;

alter table flashcards enable row level security;

create policy "Students can view their own flashcards"
    on flashcards for select using (auth.uid() = student_id);

create policy "Students can insert their own flashcards"
    on flashcards for insert with check (auth.uid() = student_id);

create policy "Students can update their own flashcards"
    on flashcards for update using (auth.uid() = student_id);

create policy "Students can delete their own flashcards"
    on flashcards for delete using (auth.uid() = student_id);

-- =====================================================================
-- Wiring note (not yet done — see README):
-- submit-quiz-attempt currently writes to `mistakes` per aggregate topic.
-- To fully move the "missed twice → flashcard" rule server-side, that
-- function should also, per-question, count prior incorrect `answers`
-- rows for (student_id, question_id); on the 2nd miss, upsert a row here
-- (source='auto_from_mistake', source_question_id=that question, pulling
-- question/answer/explanation straight off the `questions` table, which
-- already has an `explanation` column from 03_question_metadata.sql).
-- =====================================================================
