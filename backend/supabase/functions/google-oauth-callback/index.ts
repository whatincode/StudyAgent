// =====================================================================
// Edge Function: google-oauth-callback
// PUBLIC endpoint — this is where Google redirects the browser after
// consent, so there is no Authorization header to check. Trust instead
// comes from verifying the signed `state` param minted by
// google-oauth-start (proves which student started this flow, and that
// it happened in the last 10 minutes).
//
// This must be deployed with --no-verify-jwt (it's a browser redirect,
// not an authenticated API call):
//   supabase functions deploy google-oauth-callback --no-verify-jwt
// Its URL must exactly match GOOGLE_REDIRECT_URI (both the secret here
// and the redirect URI registered on the Google Cloud OAuth client).
// =====================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyState } from "../_shared/google/state.ts";

function html(body: string, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html" } });
}

// Closes the popup and tells the app it worked, via postMessage to the window
// that opened it. Falls back to a plain message if it wasn't opened as a popup.
function successPage() {
  return html(`<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:40px">
    <p>Google Classroom connected. You can close this tab.</p>
    <script>
      if (window.opener) { window.opener.postMessage({ type: 'studypilot_gc_connected' }, '*'); window.close(); }
    </script>
  </body></html>`);
}
function errorPage(msg: string) {
  return html(`<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:40px">
    <p>Couldn't connect Google Classroom: ${msg.replace(/</g, "&lt;")}</p>
    <script>
      if (window.opener) { window.opener.postMessage({ type: 'studypilot_gc_error', message: ${JSON.stringify(msg)} }, '*'); }
    </script>
  </body></html>`, 400);
}

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const oauthError = url.searchParams.get("error");
    if (oauthError) return errorPage(`Google returned "${oauthError}" (you may have declined consent).`);
    if (!code || !state) return errorPage("Missing code or state in redirect.");

    const signingSecret = Deno.env.get("INTERNAL_API_KEY")!;
    const studentId = await verifyState(state, signingSecret);
    if (!studentId) return errorPage("This connection link expired or is invalid — please try connecting again.");

    const clientId = Deno.env.get("GOOGLE_CLIENT_ID")!;
    const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
    const redirectUri = Deno.env.get("GOOGLE_REDIRECT_URI")!;

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: clientId, client_secret: clientSecret,
        redirect_uri: redirectUri, grant_type: "authorization_code",
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) return errorPage(tokens.error_description ?? tokens.error ?? "token exchange failed");
    if (!tokens.refresh_token) {
      // Happens if the student had already consented before without `prompt=consent`
      // taking effect, or Google otherwise withheld it. Without a refresh_token we
      // can't sync again once the short-lived access_token expires.
      return errorPage("Google didn't return a refresh token. Go to your Google Account's 'Third-party access' settings, remove StudyPilot, and try connecting again.");
    }

    // Best-effort: fetch which Google account this is, so Settings can show it.
    // Never fatal — a failure here shouldn't break the connection itself.
    let googleEmail: string | null = null;
    try {
      const meRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (meRes.ok) googleEmail = (await meRes.json()).email ?? null;
    } catch { /* ignore — email is a nice-to-have, not required to connect */ }

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const expiresAt = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString();
    const { error: upsertErr } = await admin.from("google_tokens").upsert({
      student_id: studentId,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: expiresAt,
      scope: tokens.scope ?? null,
      google_email: googleEmail,
      updated_at: new Date().toISOString(),
    }, { onConflict: "student_id" });
    if (upsertErr) return errorPage(upsertErr.message);

    return successPage();
  } catch (e) {
    return errorPage(String(e));
  }
});
