// =====================================================================
// Edge Function: classroom-sync
// Pulls the signed-in student's Google Classroom courses, coursework,
// coursework materials and announcements, and indexes everything it can
// turn into text so ai-tutor's grounded-answer mode can actually see it:
//
//   - Native Google Docs / Slides  -> exported to plain text via Drive
//     (source_type 'google_doc' / 'google_slides').
//   - PDFs                         -> downloaded and text-extracted with
//     unpdf (source_type 'pdf_text'). Scanned/image-only PDFs with no
//     text layer will still come back empty and fall through to
//     'not_extracted' — OCR is a further upgrade, out of scope here.
//   - Links, YouTube videos, Forms -> not full-text (nothing to extract),
//     but recorded with their title + URL (source_type 'link') so the
//     tutor can at least name and point to them instead of the material
//     never existing as far as the database is concerned.
//   - Anything else (images, Sheets, unknown types, oversized files)
//     -> recorded as 'not_extracted', same as before.
//
// See database/10_google_classroom.sql and 11_classroom_pdf_and_links.sql
// for the schema and the reasoning behind this scope.
//
// Deploy:  supabase functions deploy classroom-sync
// Call:    POST /functions/v1/classroom-sync   (Authorization: Bearer <user token>)
// Returns: { courses, materials_extracted, materials_not_extracted, materials_pending, chunks }
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { extractText, getDocumentProxy } from "https://esm.sh/unpdf@0.12.1?target=deno";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

// Thrown when Google tells us the connection itself is bad (expired/revoked
// refresh token, or a 401 mid-sync) — distinct from "this one course/file
// isn't accessible", which is handled inline and isn't fatal.
class ReauthRequiredError extends Error {
  constructor() { super("GOOGLE_REAUTH_REQUIRED"); }
}

type Token = { access_token: string; refresh_token: string; expires_at: string };

async function refreshAccessToken(refreshToken: string): Promise<{ access_token: string; expires_in: number }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      grant_type: "refresh_token",
    }),
  });
  const out = await res.json();
  if (!res.ok) {
    // invalid_grant = refresh token was revoked (e.g. student removed access in
    // their Google Account) — no amount of retrying fixes that, only reconnecting does.
    if (out.error === "invalid_grant") throw new ReauthRequiredError();
    throw new Error(`Google token refresh failed: ${out.error_description ?? out.error}`);
  }
  return out;
}

// Follows nextPageToken up to a bounded number of pages, so one sync
// can't run away on a student with an unusually large number of courses.
async function listAll(baseUrl: string, itemsKey: string, accessToken: string, maxPages = 5): Promise<any[]> {
  let items: any[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const url = new URL(baseUrl);
    url.searchParams.set("pageSize", "50");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      if (res.status === 401) throw new ReauthRequiredError();
      if (res.status === 403 || res.status === 404) return items; // no access / nothing here — not fatal
      throw new Error(`Classroom API error ${res.status} on ${baseUrl}`);
    }
    const data = await res.json();
    items = items.concat(data[itemsKey] ?? []);
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return items;
}

function chunkText(text: string, size = 800): string[] {
  const paras = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && (cur.length + p.length + 1) > size) { chunks.push(cur.trim()); cur = p; }
    else cur = cur ? `${cur} ${p}` : p;
  }
  if (cur) chunks.push(cur.trim());
  return chunks;
}

// Runs `fn` over `items` with at most `limit` in flight at once — Classroom/Drive
// have per-minute rate limits, and PDF downloads+parsing are heavy enough that
// unbounded parallelism risks both 429s and the Edge Function's own time limit.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

type MaterialRef =
  | { kind: "drive"; id: string; title: string }
  | { kind: "link"; url: string; title: string };

// Pulls every attachment out of a courseWork/courseWorkMaterial/announcement
// item's `materials[]` — a Drive file, OR a link/YouTube video/Form, which
// previously were dropped here entirely (materials.driveFile was the only
// case handled, so a course whose "materials" were all links looked empty).
function extractMaterialRefs(materials: any[] | undefined): MaterialRef[] {
  const out: MaterialRef[] = [];
  for (const m of materials ?? []) {
    const f = m?.driveFile?.driveFile;
    if (f?.id) { out.push({ kind: "drive", id: f.id, title: f.title ?? "(untitled)" }); continue; }
    if (m?.link?.url) { out.push({ kind: "link", url: m.link.url, title: m.link.title || m.link.url }); continue; }
    if (m?.youtubeVideo?.id) {
      out.push({
        kind: "link",
        url: m.youtubeVideo.alternateLink || `https://www.youtube.com/watch?v=${m.youtubeVideo.id}`,
        title: m.youtubeVideo.title || "(YouTube video)",
      });
      continue;
    }
    if (m?.form?.formUrl) out.push({ kind: "link", url: m.form.formUrl, title: m.form.title || "(Google Form)" });
  }
  return out;
}

function dedupeRefs(refs: MaterialRef[]): MaterialRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const key = r.kind === "drive" ? `d:${r.id}` : `l:${r.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const MAX_FILES_PER_SYNC = 120; // keeps one run comfortably inside the Edge Function time budget
const MAX_PDF_BYTES = 20 * 1024 * 1024; // 20MB — bigger PDFs are recorded as not_extracted, not downloaded
const MAX_RAW_TEXT_CHARS = 60_000; // per material — keeps chunk counts and prompt sizes sane

async function extractPdfText(accessToken: string, fileId: string): Promise<string | null> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  try {
    const pdf = await getDocumentProxy(buf);
    const { text } = await extractText(pdf, { mergePages: true });
    return (text ?? "").trim() || null;
  } catch {
    return null; // encrypted, corrupt, or scanned-with-no-text-layer — treated as not_extracted
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return json({ error: "Not authenticated" }, 401);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: tokenRow, error: tokenErr } = await admin
      .from("google_tokens").select("access_token, refresh_token, expires_at").eq("student_id", user.id).maybeSingle();
    if (tokenErr) return json({ error: tokenErr.message }, 500);
    if (!tokenRow) return json({ error: "Google Classroom is not connected for this account yet." }, 400);

    let accessToken = (tokenRow as Token).access_token;
    try {
      const expiresAt = new Date((tokenRow as Token).expires_at).getTime();
      if (Date.now() > expiresAt - 60_000) { // refresh a minute early
        const refreshed = await refreshAccessToken((tokenRow as Token).refresh_token);
        accessToken = refreshed.access_token;
        await admin.from("google_tokens").update({
          access_token: accessToken,
          expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        }).eq("student_id", user.id);
      }

      // 1. Courses
      const courses = await listAll("https://classroom.googleapis.com/v1/courses?courseStates=ACTIVE", "courses", accessToken);
      const courseRowsById = new Map<string, string>(); // google_course_id -> our uuid
      for (const c of courses) {
        const { data: row, error } = await admin
          .from("classroom_courses")
          .upsert({ student_id: user.id, google_course_id: c.id, name: c.name, synced_at: new Date().toISOString() }, { onConflict: "student_id,google_course_id" })
          .select("id").single();
        if (!error && row) courseRowsById.set(c.id, row.id);
      }

      // 2. courseWork + courseWorkMaterials + announcements per course -> every attachment,
      //    Drive file or otherwise, deduped within the course.
      const refsByCourse = new Map<string, MaterialRef[]>();
      for (const c of courses) {
        const [work, materials, announcements] = await Promise.all([
          listAll(`https://classroom.googleapis.com/v1/courses/${c.id}/courseWork`, "courseWork", accessToken),
          listAll(`https://classroom.googleapis.com/v1/courses/${c.id}/courseWorkMaterials`, "courseWorkMaterial", accessToken),
          listAll(`https://classroom.googleapis.com/v1/courses/${c.id}/announcements`, "announcements", accessToken),
        ]);
        const refs = [...work, ...materials, ...announcements].flatMap((item) => extractMaterialRefs(item.materials));
        refsByCourse.set(c.id, dedupeRefs(refs));
      }

      // 3. Flatten to a single work list (course row id + ref), capped so one sync
      //    can't run indefinitely; anything past the cap is left for the next sync.
      const work: { courseRowId: string; ref: MaterialRef }[] = [];
      for (const c of courses) {
        const courseRowId = courseRowsById.get(c.id);
        if (!courseRowId) continue;
        for (const ref of refsByCourse.get(c.id) ?? []) work.push({ courseRowId, ref });
      }
      const toProcess = work.slice(0, MAX_FILES_PER_SYNC);
      const pending = work.length - toProcess.length;

      // 4. Extract/record each attachment, chunk what has text, store — a few in flight at once.
      let extracted = 0, notExtracted = 0, chunkCount = 0;
      await mapLimit(toProcess, 4, async ({ courseRowId, ref }) => {
        let sourceType: "google_doc" | "google_slides" | "pdf_text" | "link" | "not_extracted" = "not_extracted";
        let rawText: string | null = null;
        let title = ref.title;
        let mimeType: string | null = null;
        let sourceUrl: string | null = null;
        let googleFileId: string;

        if (ref.kind === "link") {
          googleFileId = `link:${ref.url}`; // keeps the unique(student_id, google_file_id) constraint meaningful for non-Drive refs
          sourceUrl = ref.url;
          sourceType = "link";
          rawText = `${ref.title}\n${ref.url}`;
        } else {
          googleFileId = ref.id;
          const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${ref.id}?fields=id,name,mimeType,size`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (metaRes.status === 401) throw new ReauthRequiredError();
          if (!metaRes.ok) { notExtracted++; return; }
          const meta = await metaRes.json();
          title = meta.name ?? ref.title;
          mimeType = meta.mimeType ?? null;

          if (mimeType === "application/vnd.google-apps.document") sourceType = "google_doc";
          else if (mimeType === "application/vnd.google-apps.presentation") sourceType = "google_slides";
          else if (mimeType === "application/pdf") sourceType = "pdf_text";

          if (sourceType === "google_doc" || sourceType === "google_slides") {
            const exportRes = await fetch(`https://www.googleapis.com/drive/v3/files/${ref.id}/export?mimeType=text/plain`, {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (exportRes.status === 401) throw new ReauthRequiredError();
            rawText = exportRes.ok ? await exportRes.text() : null;
            if (!rawText) sourceType = "not_extracted";
          } else if (sourceType === "pdf_text") {
            const size = meta.size ? Number(meta.size) : 0;
            rawText = size && size > MAX_PDF_BYTES ? null : await extractPdfText(accessToken, ref.id);
            if (!rawText) sourceType = "not_extracted";
          }
        }

        if (rawText && rawText.length > MAX_RAW_TEXT_CHARS) rawText = rawText.slice(0, MAX_RAW_TEXT_CHARS);

        const { data: matRow, error: matErr } = await admin
          .from("classroom_materials")
          .upsert({
            student_id: user.id, course_id: courseRowId, google_file_id: googleFileId,
            title, mime_type: mimeType, source_type: sourceType, source_url: sourceUrl,
            raw_text: rawText, synced_at: new Date().toISOString(),
          }, { onConflict: "student_id,google_file_id" })
          .select("id").single();

        if (matErr || !matRow) { notExtracted++; return; }
        if (sourceType === "not_extracted" || !rawText) { notExtracted++; return; }
        extracted++;

        // Re-sync: drop old chunks for this material before inserting fresh ones.
        await admin.from("classroom_chunks").delete().eq("material_id", matRow.id);
        const chunks = chunkText(rawText);
        if (chunks.length) {
          await admin.from("classroom_chunks").insert(
            chunks.map((content, i) => ({ material_id: matRow.id, student_id: user.id, chunk_index: i, content })),
          );
          chunkCount += chunks.length;
        }
      });

      return json({
        courses: courses.length,
        materials_extracted: extracted,
        materials_not_extracted: notExtracted,
        materials_pending: pending, // picked up automatically on the next "Sync now"
        chunks: chunkCount,
      });
    } catch (e) {
      if (e instanceof ReauthRequiredError) {
        // The stored tokens no longer work — clear them so Settings shows "not
        // connected" instead of a connection that silently syncs nothing forever.
        await admin.from("google_tokens").delete().eq("student_id", user.id);
        return json({ error: "Your Google Classroom connection expired or was revoked. Please reconnect." }, 401);
      }
      throw e;
    }
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
