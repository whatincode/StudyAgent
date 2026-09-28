# StudyPilot AI

An autonomous study agent for personalized learning. StudyPilot watches a student's quiz evidence, scores every topic against target thresholds, and decides — with a stated confidence score and a written reason — what the student should work on next. It then hands off to a Socratic AI tutor for that topic.

The whole thing runs as a **single-file frontend in demo mode with zero setup**, and can optionally be pointed at a real Supabase backend for persistent, multi-user data.

## How it works: the agent loop

The core of the project is a bounded, explainable **perceive → analyze → decide → act** loop, re-run every time new evidence arrives (a quiz submission, or a manual "Re-run cycle"):

1. **Perceive** — reads the student's latest quiz attempts, accuracy, trend, and logged mistakes per topic.
2. **Analyze** — scores every topic against two thresholds: below 55% accuracy is a `knowledge_gap`, below 75% is `needs_practice`, above that is `strong`.
3. **Decide** — weighs each topic on accuracy gap, recent trend, and mistake count, and picks the single highest-priority topic with a confidence score.
4. **Act** — writes a plain-language recommendation and a concrete 3-step micro-plan (warm-up quiz → Socratic tutor session → re-check).

Every decision is logged with a timestamp and reason, so the agent's reasoning is auditable, not a black box.

## What's new: Google Classroom integration

Opt-in, per-student grounding of the AI Tutor in a student's own Google Classroom material — nothing is pulled until the student explicitly connects their account, and nothing is used in an answer unless they also check "Answer using my Google Classroom material" for that specific question.

- **Connect** (Settings page) — starts a standard Google OAuth consent flow (`google-oauth-start` → Google's consent screen → `google-oauth-callback`, a public redirect endpoint that verifies a signed, short-lived `state` token before storing the resulting tokens).
- **Sync** — `classroom-sync` pulls the student's active courses, coursework, coursework *materials* (the Classwork tab's reference materials, not just graded work) and announcements, and indexes everything it can turn into text: **Google Docs/Slides** export to plain text via Drive, **PDFs** are downloaded and text-extracted (`unpdf`), and **links/YouTube videos/Forms** — which aren't Drive files and have nothing to extract — are still recorded with their title and URL so the tutor can name and point to them. Only genuinely unreadable attachments (images, Sheets, encrypted or scanned-with-no-text PDFs, oversized files) end up `not_extracted`. See `database/10_google_classroom.sql` and `database/11_classroom_pdf_and_links.sql` for the schema.
  - **If you connected Classroom before this update, click "Reconnect" once** (Settings → Google Classroom). The Classwork-materials endpoint needs its own OAuth scope (`classroom.courseworkmaterials.readonly`), which wasn't being requested before — without it that whole tab 403s and silently syncs as empty, which is why old syncs undercounted.
- **Retrieval** uses Postgres full-text search (`tsvector` + `websearch_to_tsquery`), not vector embeddings — a deliberate scope choice that needs no extra embedding API or extension while still doing real keyword-relevance search over synced material. `ai-tutor` folds the top matches into its system prompt only when `use_classroom: true` is sent, exactly like the existing uploaded-document grounding.
- **Demo mode** simulates the same shape of feature with two small "class notes" documents and simple client-side keyword matching (`connectClassroomDemo()` / `demoClassroomAnswer()`) — no OAuth or backend needed to see the idea working end to end.
- **Demo-scope note for judges**: while the Google OAuth consent screen is in "Testing" mode (the default for a new project, and normal for a hackathon), only accounts added as Test users (up to 100) can complete the flow, and they'll see an "unverified app" warning during consent — both are expected and don't require Google's full verification review to demo.

## What's new: AI content generation, agent trust score

- **Create tab** — three generators, organized into clear sub-tabs:
  - **Topic → quiz**: type any topic, get a real LLM-written multiple-choice quiz with difficulty tags, stored exactly like a seeded quiz (`generate-quiz`).
  - **Topic → flashcards**: same idea, straight into the SM-2 review queue (`generate-flashcards`).
  - **Notes/PDF → quiz + flashcards**: paste notes or upload a PDF (extracted client-side with pdf.js — the server only ever sees plain text) and get content grounded *only* in that material (`generate-from-notes`). Once it finishes, the notes are cleared and you're taken straight to the new flashcards (or quiz, if you chose quiz-only).
  - In **demo mode** (no backend, no API key), topic generation instead builds an offline study-skills self-check — it's upfront that it can't verify facts about a topic it's never seen. Notes/PDF extraction works fully offline in demo mode too, since it's your own text, not an invented fact.
- **Agent trust score** — the orchestrator's existing outcome feedback loop (`07_agent_feedback_loop.sql`, `closeFeedbackLoop()`) is now surfaced directly on the Agent page: "X% of the last N recommendations improved accuracy," backed by the same `baseline_accuracy`/`outcome_accuracy`/`outcome_delta` columns the agent was already writing. New read-only endpoint: `get-agent-trust`.

## What's new: flashcards, more visualization, quiz enhancements

- **Flashcards** — SM-2 spaced repetition. Any question missed twice becomes a flashcard automatically (demo mode: `registerWrongAnswer()`; live mode: `submit-quiz-attempt` does the same server-side). Review with Again/Hard/Good/Easy; the "Flashcards" nav tab shows a due-today count.
- **More visualization** on the Dashboard — accuracy-over-time line chart, a topic-mastery radar chart, a GitHub-style study-activity heatmap, and a confidence-vs-accuracy scatter plot (using the agent's own per-topic priority score), alongside the original bar/pie charts.
- **Quiz enhancements** — an "Adaptive practice" mode next to the standard quiz: one question at a time, difficulty steps up or down based on your running accuracy, per-question response time is logged, and every wrong answer in either mode now shows the correct answer with an explanation.

In **live mode**, adaptive difficulty for the *standard* quiz is already handled server-side in `get-quiz` (it picks easy/medium/hard from recent topic accuracy) — the frontend's new "Adaptive practice" is a separate, demo-mode-only one-question-at-a-time flow layered on top of the existing 8-question demo pool per topic (previously 4–5; expanded for difficulty variety).

## Two ways to run it

### 1. Demo mode (default, no setup)

Open `index.html` directly in a browser. It runs entirely client-side against two hardcoded demo students (Aarav, Sneha) with pre-loaded quiz history. No backend, no API keys, no network calls. This is the easiest way to see the full app — dashboard, weak-spot analysis, quizzes, the AI tutor (deterministic canned responses), and the agent console — end to end.

> Note: in demo mode, "Re-run cycle" replays the agent's decision against the *current* evidence — it won't change the numbers unless new evidence has actually arrived. Submitting a quiz is what updates a topic's accuracy/trend/mistakes and produces a different recommendation.

### 2. Live mode (real Supabase backend)

Connect the same `index.html` to a real Supabase project for persistent accounts, real quiz storage, and an LLM-powered tutor/agent. See [Deploying the backend](#deploying-the-backend) below.

## Project structure

```
.
├── index.html              # The entire frontend — demo mode + live-mode client
├── backend/
│   └── supabase/
│       └── functions/       # Supabase Edge Functions (Deno)
│           ├── get-quiz/
│           ├── submit-quiz-attempt/    # now also auto-creates a flashcard on a question's 2nd miss
│           ├── get-flashcards/         # returns the student's flashcards, due-today first
│           ├── review-flashcard/       # SM-2 review + manual card creation
│           ├── generate-quiz/          # NEW — topic → real AI-written quiz
│           ├── generate-flashcards/    # NEW — topic → real AI-written flashcards
│           ├── generate-from-notes/    # NEW — pasted notes/PDF text → quiz + flashcards, grounded only in that text
│           ├── get-agent-trust/        # NEW — rolls up the agent's outcome feedback loop into one trust %
│           ├── google-oauth-start/     # NEW — builds the signed Google consent URL
│           ├── google-oauth-callback/  # NEW — public redirect target; exchanges code for tokens
│           ├── classroom-sync/         # NEW — pulls courses/coursework, exports Docs/Slides text, chunks it
│           ├── get-assessment-analytics/
│           ├── agent-cycle/            # Runs the perceive→analyze→decide→act loop server-side
│           ├── ai-tutor/               # LLM-backed Socratic tutor — now also grounds in synced Classroom material
│           └── _shared/
│               ├── assessment/         # Scoring, knowledge-gap, mistake-classification engines
│               ├── agent/              # Orchestrator + LLM provider abstraction
│               ├── xai/                # Evidence-gathering helpers
│               └── google/             # NEW — HMAC sign/verify for the OAuth state param
└── database/
    ├── 01_schema.sql                  # Core tables (profiles, courses, quizzes, questions, attempts, recommendations)
    ├── 02_row_level_security.sql      # RLS: students can only read/write their own data
    ├── 03_question_metadata.sql       # Concept/difficulty/explanation columns for adaptive scoring
    ├── 04_seed_content.sql            # Seed courses, lessons, quizzes, questions
    ├── 05_protect_answer_key.sql      # Column-level grants so answers aren't readable client-side
    ├── 06_demo_students.sql           # 4 demo student logins with realistic quiz history
    ├── 07_agent_feedback_loop.sql     # Outcome tracking: did the last recommendation actually help?
    ├── 08_flashcards.sql              # Flashcards table + RLS for SM-2 spaced repetition
    └── 09_ai_generated_content.sql    # Source tracking on quizzes/flashcards + study_materials table
    └── 10_google_classroom.sql        # NEW — OAuth tokens, synced courses/materials, searchable chunks
    └── 11_classroom_pdf_and_links.sql # NEW — google_email column, 'link' material type + source_url
```

## Deploying the backend

1. **Create a project** at [supabase.com/dashboard](https://supabase.com/dashboard) and grab its Project URL and anon/public key from Project Settings → API.
2. **Install the CLI and link**: `npm install -g supabase`, `supabase login`, then `supabase link --project-ref <your-ref>` from the `backend/supabase` folder.
3. **Run the SQL migrations in order**, via the SQL Editor or `supabase db push`:
   `01_schema.sql → 02_row_level_security.sql → 03_question_metadata.sql → 04_seed_content.sql → 05_protect_answer_key.sql → 06_demo_students.sql → 07_agent_feedback_loop.sql → 08_flashcards.sql → 09_ai_generated_content.sql → 10_google_classroom.sql → 11_classroom_pdf_and_links.sql`
4. **Set Edge Function secrets** (`supabase secrets set KEY=value`):
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` — from Project Settings → API
   - One of `GROQ_API_KEY`, `GEMINI_API_KEY`, or `ANTHROPIC_API_KEY` — powers the tutor, the agent's reasoning, and all three content generators (checked in that priority order; override with `AI_PROVIDER` / `AI_MODEL`)
   - `INTERNAL_API_KEY` — any random string, used to authenticate internal calls between functions **and** to sign the Google OAuth `state` parameter (see below) — no separate secret needed for that.
   - For Google Classroom: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` — see "Google Cloud setup" below. Skip these if you don't need the Classroom feature; every other function works fine without them, and Settings will just say Classroom isn't configured.
5. **Deploy the functions**: `supabase functions deploy get-quiz submit-quiz-attempt get-assessment-analytics agent-cycle ai-tutor get-flashcards review-flashcard generate-quiz generate-flashcards generate-from-notes get-agent-trust google-oauth-start classroom-sync`
   then deploy the OAuth callback separately, since it's a public browser redirect with no user JWT to verify: `supabase functions deploy google-oauth-callback --no-verify-jwt`
6. **Connect the frontend**: open `index.html`, go to the Connect page (⇄ icon), and paste in the Project URL and anon key. Or hardcode them into `LIVE` in `index.html` to skip that step for your own deployment.

### Google Cloud setup (only needed for the Classroom integration)

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com), enable the **Google Classroom API** and **Google Drive API** (APIs & Services → Library).
2. Create an OAuth 2.0 Client ID (APIs & Services → Credentials → Create Credentials → OAuth client ID → Web application). Add an Authorized redirect URI pointing at your deployed `google-oauth-callback` function's URL — it must match `GOOGLE_REDIRECT_URI` exactly.
3. On the OAuth consent screen, while it's in **Testing** mode (the default), add every Google account you want to demo with as a **Test user** (up to 100) — accounts not in this list can't complete the flow. Testers will see an "unverified app" warning during consent; that's expected and doesn't block the demo.
4. Set the three secrets above, deploy `google-oauth-start`, `google-oauth-callback` (with `--no-verify-jwt`), and `classroom-sync`, then run `10_google_classroom.sql` and `11_classroom_pdf_and_links.sql`. If you'd already deployed the Classroom feature before this update, redeploy `google-oauth-start`/`google-oauth-callback`/`classroom-sync` and have every already-connected student click "Reconnect" once (new scopes require re-consent).

## Tech stack

- **Frontend**: vanilla JS, no framework, no build step — a single `index.html`
- **Backend**: Supabase (Postgres + Auth + Row Level Security) and Deno-based Edge Functions
- **AI**: pluggable LLM provider (Groq, Gemini, or Anthropic) for the tutor and the agent's decision-making

## Security notes

- Row Level Security ensures every student can only read/write their own data.
- Quiz **answers** are protected at the column-privilege level (`05_protect_answer_key.sql`) — the frontend never queries the `questions` table directly for answers; only `get-quiz` (using the service role) can see them.
- The Supabase **anon key** is safe to expose client-side by design — it identifies the project, not a privileged account, and all access is gated by RLS and Edge Function auth.
