-- =====================================================================
-- AI-Powered Personalized Education Platform
-- Member 2 — Backend, Database & Deployment Infrastructure
-- Step 1: Core Supabase PostgreSQL schema (explanation-ready for XAI)
-- =====================================================================
-- Run this in the Supabase SQL Editor (or via `supabase db push`).
-- Assumes Supabase Auth is enabled (auth.users table already exists).
-- =====================================================================

create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------
-- 1. PROFILES  — one row per student, linked to auth.users
-- ---------------------------------------------------------------------
create table if not exists profiles (
    id              uuid primary key references auth.users(id) on delete cascade,
    full_name       text,
    age_group       text        check (age_group in ('6-10','11-14','15-18','18+')),
    education_level text,                      -- e.g. 'primary', 'secondary', 'undergrad'
    language        text        default 'en',
    goals           text[]      default '{}',  -- e.g. {'crack JEE','learn web dev'}
    preferences     jsonb       default '{}',  -- accessibility + UI prefs
    created_at      timestamptz default now(),
    updated_at      timestamptz default now()
);

-- ---------------------------------------------------------------------
-- 2. COURSES & LESSONS — structured learning content
-- ---------------------------------------------------------------------
create table if not exists courses (
    id          uuid primary key default uuid_generate_v4(),
    title       text not null,
    subject     text not null,
    level       text,                          -- beginner / intermediate / advanced
    description text,
    created_at  timestamptz default now()
);

create table if not exists lessons (
    id          uuid primary key default uuid_generate_v4(),
    course_id   uuid references courses(id) on delete cascade,
    title       text not null,
    content     text,                          -- lesson body / notes
    order_index int default 0,
    created_at  timestamptz default now()
);

-- ---------------------------------------------------------------------
-- 3. QUIZZES & QUESTIONS
-- ---------------------------------------------------------------------
create table if not exists quizzes (
    id          uuid primary key default uuid_generate_v4(),
    lesson_id   uuid references lessons(id) on delete set null,
    topic       text not null,
    difficulty  text check (difficulty in ('easy','medium','hard')) default 'medium',
    created_at  timestamptz default now()
);

create table if not exists questions (
    id          uuid primary key default uuid_generate_v4(),
    quiz_id     uuid references quizzes(id) on delete cascade,
    question    text not null,
    options     jsonb not null,                -- e.g. ["A","B","C","D"]
    answer      text not null,                 -- correct option
    created_at  timestamptz default now()
);

-- ---------------------------------------------------------------------
-- 4. ATTEMPTS & ANSWERS — every quiz attempt a student makes
-- ---------------------------------------------------------------------
create table if not exists quiz_attempts (
    id          uuid primary key default uuid_generate_v4(),
    student_id  uuid references profiles(id) on delete cascade,
    quiz_id     uuid references quizzes(id) on delete cascade,
    score       numeric,                       -- e.g. 6 out of 10
    total       numeric,
    completed_at timestamptz default now()
);

create table if not exists answers (
    id              uuid primary key default uuid_generate_v4(),
    attempt_id      uuid references quiz_attempts(id) on delete cascade,
    question_id     uuid references questions(id) on delete cascade,
    selected_answer text,
    correct         boolean,
    created_at      timestamptz default now()
);

-- ---------------------------------------------------------------------
-- 5. PROGRESS — per-student, per-topic completion & accuracy
-- ---------------------------------------------------------------------
create table if not exists progress (
    id          uuid primary key default uuid_generate_v4(),
    student_id  uuid references profiles(id) on delete cascade,
    topic_id    uuid references lessons(id) on delete cascade,
    completion  numeric default 0,             -- 0–100 (%)
    accuracy    numeric default 0,             -- 0–100 (%)
    updated_at  timestamptz default now(),
    unique (student_id, topic_id)
);

-- ---------------------------------------------------------------------
-- 6. MISTAKES — the Mistake Journal's data source
-- ---------------------------------------------------------------------
create table if not exists mistakes (
    id          uuid primary key default uuid_generate_v4(),
    student_id  uuid references profiles(id) on delete cascade,
    topic       text not null,
    error_type  text,                          -- e.g. 'conceptual', 'silly mistake'
    question_id uuid references questions(id) on delete set null,
    count       int default 1,
    date        timestamptz default now()
);

-- ---------------------------------------------------------------------
-- 7. RECOMMENDATIONS — explanation-ready for the XAI layer (Member 3)
-- ---------------------------------------------------------------------
create table if not exists recommendations (
    id                   uuid primary key default uuid_generate_v4(),
    student_id           uuid references profiles(id) on delete cascade,
    recommended_topic    text not null,
    priority             text check (priority in ('low','medium','high')) default 'medium',
    status                text check (status in ('pending','shown','accepted','dismissed')) default 'pending',

    -- ---- XAI fields: written by Member 3, read by Member 1's "Why this?" UI ----
    reason               text,        -- human-readable rationale, e.g.
                                       -- "3 recent mistakes in Loops, 60% accuracy vs 85% goal"
    confidence_score     numeric check (confidence_score >= 0 and confidence_score <= 1),
    contributing_factors jsonb default '[]',
                                       -- e.g. [{"factor":"accuracy","value":0.6,"weight":0.5},
                                       --       {"factor":"recent_mistakes","value":3,"weight":0.3}]

    created_at           timestamptz default now()
);

-- ---------------------------------------------------------------------
-- 8. LEARNING GOALS
-- ---------------------------------------------------------------------
create table if not exists learning_goals (
    id            uuid primary key default uuid_generate_v4(),
    student_id    uuid references profiles(id) on delete cascade,
    goal          text not null,
    target_skills text[] default '{}',
    created_at    timestamptz default now()
);

-- ---------------------------------------------------------------------
-- 9. AGENT RUNS — the audit trail of the agent's Perceive/Analyze/Decide/Act
--    loop. Every time the loop runs (after a quiz submission, or on demand),
--    one row is written here with what it saw, how it scored the candidates,
--    what it chose, and what it did about it. This is what makes the agent
--    inspectable rather than a black box, and it's what a grader can point
--    to as evidence of an actual agent architecture (not just a chatbot).
-- ---------------------------------------------------------------------
create table if not exists agent_runs (
    id                uuid primary key default uuid_generate_v4(),
    student_id        uuid references profiles(id) on delete cascade,
    trigger           text not null,               -- e.g. 'quiz_attempt:<id>', 'manual'
    perceived         jsonb not null,               -- evidence snapshot the run started from
    analysis          jsonb not null,               -- per-topic scoring the run computed
    decision          jsonb,                        -- the chosen topic + confidence + factors (null if no decision was possible)
    action            jsonb,                        -- what was written/queued as a result
    recommendation_id uuid references recommendations(id) on delete set null,
    created_at        timestamptz default now()
);

-- ---------------------------------------------------------------------
-- Helpful indexes for the queries the dashboard/analytics will run most
-- ---------------------------------------------------------------------
create index if not exists idx_attempts_student on quiz_attempts(student_id);
create index if not exists idx_progress_student on progress(student_id);
create index if not exists idx_mistakes_student on mistakes(student_id);
create index if not exists idx_recommendations_student on recommendations(student_id);
create index if not exists idx_agent_runs_student on agent_runs(student_id, created_at desc);
