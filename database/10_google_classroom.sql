-- =====================================================================
-- 10 — Google Classroom integration
--
-- Lets a student connect their own Google Classroom account (OAuth,
-- per-user, opt-in) so StudyPilot can pull their course materials and
-- ground the AI tutor's answers in them instead of just general
-- knowledge.
--
-- Retrieval note: this uses Postgres full-text search (tsvector +
-- ts_rank), not vector embeddings/pgvector. That's a deliberate scope
-- choice — it needs no extra embedding API, no extra quota, and no new
-- extension, while still doing real keyword-relevance retrieval over
-- the synced material. If you want true semantic (meaning-based, not
-- keyword) search later, swap classroom_chunks.tsv for a pgvector
-- `embedding` column and change the query in ai-tutor's
-- searchClassroomChunks() accordingly — nothing else here needs to change.
--
-- Run AFTER 01_schema.sql and 02_row_level_security.sql.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. OAUTH TOKENS — one row per student who has connected Classroom.
--    NOTE: for a real production deployment, encrypt access_token /
--    refresh_token at rest (e.g. with pgsodium/Vault) instead of storing
--    them as plain text. RLS keeps them student-only either way, but
--    encryption-at-rest is a further hardening step intentionally left
--    for a production pass, not this hackathon-scope build.
-- ---------------------------------------------------------------------
create table if not exists google_tokens (
    student_id     uuid primary key references profiles(id) on delete cascade,
    access_token   text not null,
    refresh_token  text,
    expires_at     timestamptz,
    scope          text,
    connected_at   timestamptz default now(),
    updated_at     timestamptz default now()
);

alter table google_tokens enable row level security;
create policy "Students can view their own google token row"   on google_tokens for select using (auth.uid() = student_id);
create policy "Students can delete their own google token row" on google_tokens for delete using (auth.uid() = student_id);
-- Insert/update on this table is done ONLY by the oauth-callback and
-- classroom-sync Edge Functions using the service role key (never
-- directly by the browser), so a stolen anon key can't plant tokens.

-- ---------------------------------------------------------------------
-- 2. SYNCED COURSES
-- ---------------------------------------------------------------------
create table if not exists classroom_courses (
    id               uuid primary key default uuid_generate_v4(),
    student_id       uuid references profiles(id) on delete cascade,
    google_course_id text not null,
    name             text,
    synced_at        timestamptz default now(),
    unique (student_id, google_course_id)
);

alter table classroom_courses enable row level security;
create policy "Students can view their own synced courses" on classroom_courses for select using (auth.uid() = student_id);

-- ---------------------------------------------------------------------
-- 3. SYNCED MATERIALS — one row per Drive file attached to coursework.
--    source_type records what we were able to do with it: native Docs/
--    Slides always extract to clean text; PDFs and other attachments
--    are recorded but flagged as not-yet-extracted rather than
--    silently skipped, so a sync's coverage is visible, not hidden.
-- ---------------------------------------------------------------------
create table if not exists classroom_materials (
    id            uuid primary key default uuid_generate_v4(),
    student_id    uuid references profiles(id) on delete cascade,
    course_id     uuid references classroom_courses(id) on delete cascade,
    google_file_id text,
    title         text,
    mime_type     text,
    source_type   text check (source_type in ('google_doc','google_slides','pdf_text','not_extracted')) default 'not_extracted',
    raw_text      text,          -- null when source_type = 'not_extracted'
    synced_at     timestamptz default now(),
    unique (student_id, google_file_id)
);

create index if not exists idx_classroom_materials_student on classroom_materials(student_id);

alter table classroom_materials enable row level security;
create policy "Students can view their own synced materials" on classroom_materials for select using (auth.uid() = student_id);

-- ---------------------------------------------------------------------
-- 4. CHUNKS — materials split into ~800-character pieces for retrieval,
--    with a generated tsvector column for full-text search.
-- ---------------------------------------------------------------------
create table if not exists classroom_chunks (
    id           uuid primary key default uuid_generate_v4(),
    material_id  uuid references classroom_materials(id) on delete cascade,
    student_id   uuid references profiles(id) on delete cascade,
    chunk_index  int not null,
    content      text not null,
    tsv          tsvector generated always as (to_tsvector('english', content)) stored,
    created_at   timestamptz default now()
);

create index if not exists idx_classroom_chunks_tsv on classroom_chunks using gin(tsv);
create index if not exists idx_classroom_chunks_student on classroom_chunks(student_id);

alter table classroom_chunks enable row level security;
create policy "Students can view their own material chunks" on classroom_chunks for select using (auth.uid() = student_id);

-- Insert/update on classroom_courses / classroom_materials / classroom_chunks
-- is done ONLY by the classroom-sync Edge Function (service role) — students
-- read their own synced data but never write it directly.

-- =====================================================================
-- Google Cloud setup this depends on (see README for the full walkthrough):
--   1. A Google Cloud project with the Classroom API + Drive API enabled.
--   2. An OAuth 2.0 Client ID (type: Web application) with a redirect URI
--      pointing at your deployed google-oauth-callback function URL.
--   3. While the OAuth consent screen is in "Testing" mode, add every
--      Google account you want to demo with as a Test user (up to 100) —
--      Console → APIs & Services → OAuth consent screen → Test users.
--   4. Edge Function secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
--      GOOGLE_REDIRECT_URI (must exactly match what's registered above),
--      and reuse the existing INTERNAL_API_KEY as the HMAC signing secret
--      for the OAuth "state" parameter (see google-oauth-start).
-- =====================================================================
