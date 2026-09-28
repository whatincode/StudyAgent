-- =====================================================================
-- 11 — Google Classroom: PDFs, links/videos, and the connected account's email
--
-- Upgrades the 10_google_classroom.sql integration so a sync captures
-- everything a course actually contains, not just native Google Docs/Slides:
--
--   1. `google_tokens.google_email` — the connected Google account's email,
--      fetched once at OAuth time (google-oauth-callback) and shown in
--      Settings. Previously queried by index.html but never stored anywhere,
--      so it silently failed and "Reconnect to capture account email" did
--      nothing.
--   2. `classroom_materials.source_type` now also allows 'link', for
--      announcement/coursework attachments that aren't a Drive file at all
--      (a shared URL, a YouTube video, a Google Form) — these are now
--      recorded with their title + URL instead of being dropped before they
--      ever reached this table.
--   3. `classroom_materials.source_url` — the attachment's URL, populated
--      for 'link' rows (and left null for Drive-backed rows, which are
--      already identified by google_file_id).
--
-- Run AFTER 10_google_classroom.sql.
-- =====================================================================

alter table google_tokens add column if not exists google_email text;

alter table classroom_materials add column if not exists source_url text;

alter table classroom_materials drop constraint if exists classroom_materials_source_type_check;
alter table classroom_materials add constraint classroom_materials_source_type_check
  check (source_type in ('google_doc', 'google_slides', 'pdf_text', 'link', 'not_extracted'));

-- =====================================================================
-- Re-consent required: the Classroom OAuth scopes changed alongside this
-- migration (classroom.courseworkmaterials.readonly + userinfo.email were
-- added — see google-oauth-start). Anyone who connected before this
-- deploy is still missing those grants; without courseworkmaterials.readonly
-- specifically, the whole "Classwork materials" tab 403s and is silently
-- treated as empty. Existing connections keep working, but each student
-- needs to click "Reconnect" once (Settings → Google Classroom) to pick up
-- the new scopes and their email. Nothing to run here for that — it's a
-- browser-side re-consent, not a data migration.
-- =====================================================================
