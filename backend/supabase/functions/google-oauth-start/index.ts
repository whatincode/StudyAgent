// =====================================================================
// Edge Function: google-oauth-start
// Returns a Google OAuth consent URL for the signed-in student to open.
// The URL's `state` param is an HMAC-signed, 10-minute-lived token
// carrying the student's id — google-oauth-callback verifies it so the
// callback (a bare browser redirect, no auth header) knows who to store
// tokens for, without a server-side session store.
//
// Setup required (see database/09_google_classroom.sql for the full list):
//   supabase secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REDIRECT_URI=...
// Deploy:  supabase functions deploy google-oauth-start
// Call:    GET /functions/v1/google-oauth-start   (Authorization: Bearer <user token>)
// Returns: { url: "https://accounts.google.com/o/oauth2/v2/auth?..." }
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { signState } from "../_shared/google/state.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

// NOTE: classroom.courseWorkMaterials.list (the "Classwork" tab's reference
// materials, separate from graded courseWork) 403s without this scope — it was
// previously missing here, which meant classroom-sync's courseWorkMaterials
// fetch silently came back empty for every student (listAll treats 403 as
// "no access", not fatal). Anyone who connected before this fix must
// reconnect once to re-consent and pick up the new scope.
const SCOPES = [
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
  "https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly",
  "https://www.googleapis.com/auth/classroom.announcements.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/userinfo.email", // lets the callback record which Google account got connected
].join(" ");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return json({ error: "GET only" }, 405);

  try {
    const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
    const redirectUri = Deno.env.get("GOOGLE_REDIRECT_URI");
    const signingSecret = Deno.env.get("INTERNAL_API_KEY");
    if (!clientId || !redirectUri || !signingSecret) {
      return json({ error: "Google Classroom is not configured on this deployment: set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, and INTERNAL_API_KEY." }, 503);
    }

    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return json({ error: "Not authenticated" }, 401);

    const state = await signState(user.id, signingSecret);
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("access_type", "offline");   // so we get a refresh_token
    url.searchParams.set("prompt", "consent");         // forces refresh_token even on repeat consent
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("state", state);

    return json({ url: url.toString() });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
