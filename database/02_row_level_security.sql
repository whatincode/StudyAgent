-- =====================================================================
-- Row Level Security (RLS) — every student can only read/write their own data
-- Run this AFTER 01_schema.sql
-- =====================================================================

-- ---- profiles ----
alter table profiles enable row level security;

create policy "Students can view their own profile"
    on profiles for select
    using (auth.uid() = id);

create policy "Students can update their own profile"
    on profiles for update
    using (auth.uid() = id);

create policy "Students can insert their own profile"
    on profiles for insert
    with check (auth.uid() = id);

-- ---- courses / lessons / quizzes / questions: public read, no student ownership ----
alter table courses   enable row level security;
alter table lessons   enable row level security;
alter table quizzes   enable row level security;
alter table questions enable row level security;

create policy "Anyone authenticated can read courses"   on courses   for select using (auth.role() = 'authenticated');
create policy "Anyone authenticated can read lessons"    on lessons   for select using (auth.role() = 'authenticated');
create policy "Anyone authenticated can read quizzes"    on quizzes   for select using (auth.role() = 'authenticated');
create policy "Anyone authenticated can read questions"  on questions for select using (auth.role() = 'authenticated');

-- ---- quiz_attempts ----
alter table quiz_attempts enable row level security;

create policy "Students can view their own attempts"
    on quiz_attempts for select using (auth.uid() = student_id);

create policy "Students can insert their own attempts"
    on quiz_attempts for insert with check (auth.uid() = student_id);

-- ---- answers (owned indirectly via quiz_attempts) ----
alter table answers enable row level security;

create policy "Students can view their own answers"
    on answers for select
    using (
        exists (
            select 1 from quiz_attempts
            where quiz_attempts.id = answers.attempt_id
              and quiz_attempts.student_id = auth.uid()
        )
    );

create policy "Students can insert their own answers"
    on answers for insert
    with check (
        exists (
            select 1 from quiz_attempts
            where quiz_attempts.id = answers.attempt_id
              and quiz_attempts.student_id = auth.uid()
        )
    );

-- ---- progress ----
alter table progress enable row level security;

create policy "Students can view their own progress"
    on progress for select using (auth.uid() = student_id);

create policy "Students can upsert their own progress"
    on progress for insert with check (auth.uid() = student_id);

create policy "Students can update their own progress"
    on progress for update using (auth.uid() = student_id);

-- ---- mistakes ----
alter table mistakes enable row level security;

create policy "Students can view their own mistakes"
    on mistakes for select using (auth.uid() = student_id);

create policy "Students can insert their own mistakes"
    on mistakes for insert with check (auth.uid() = student_id);

-- ---- recommendations (student reads; only backend/service role writes) ----
alter table recommendations enable row level security;

create policy "Students can view their own recommendations"
    on recommendations for select using (auth.uid() = student_id);

-- Note: INSERT/UPDATE on recommendations is intentionally NOT open to students.
-- Member 3's Edge Function writes these using the service role key, so the
-- AI/XAI engine is the only writer of `reason`, `confidence_score`, and
-- `contributing_factors`.

-- ---- agent_runs (student reads their own trail; only the backend, using the
--      service role key, ever writes a row — the agent's log can't be faked
--      or edited from the browser) ----
alter table agent_runs enable row level security;

create policy "Students can view their own agent runs"
    on agent_runs for select using (auth.uid() = student_id);

-- ---- learning_goals ----
alter table learning_goals enable row level security;

create policy "Students can view their own goals"
    on learning_goals for select using (auth.uid() = student_id);

create policy "Students can insert their own goals"
    on learning_goals for insert with check (auth.uid() = student_id);

create policy "Students can update their own goals"
    on learning_goals for update using (auth.uid() = student_id);
