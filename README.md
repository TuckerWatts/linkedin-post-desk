# Post Desk

Plan, approve, publish and reshare LinkedIn posts for a company page and its founder.

- **Review drafts** one at a time, with a checker that flags wording that reads as AI-written (em dashes, buzzwords, hashtag spam, links).
- **Approve & plan**: each draft gets a suggested time that looks human (2–3 days apart, uneven minutes, mostly weekdays), within the times of day you pick in Settings (morning and midday by default).
- **Auto-publish** to the company page through LinkedIn's API, including **carousel (PDF document) posts** built from slide text in your brand.
- **Auto-reshare** each company post from the founder's profile a few hours later, with a short personal note.
- **Comments** on company posts are pulled in so you can reply on LinkedIn yourself.
- **Drafting with Claude** (optional): keeps the pipeline full and rewrites drafts from your notes.
- **Works before LinkedIn approval**: accounts can run in "post by hand" mode (copy, open LinkedIn, paste, mark posted).

Next.js 14 (App Router) · Postgres · no ORM · single admin login. Every table is scoped by `workspace_id`, so it can serve multiple companies later.

---

## Quick start (local)

```bash
cp .env.example .env          # fill in DATABASE_URL, ADMIN_PASSWORD, APP_SECRET, CRON_SECRET
npm install
npm run db:migrate
npm run db:seed               # optional: imports the posts from seed/example.json
npm run dev                   # http://localhost:3000
npm test                      # no database or network needed
```

Generate secrets with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

## Deploy (Vercel + Neon, or anything that runs Next.js)

1. Create a Postgres database (Neon, Supabase, Railway…) and run `npm run db:migrate` against it.
2. Import the repo into Vercel and set the variables from `.env.example`. `APP_URL` must be the deployed URL.
3. Pick **one** scheduler:
   - **GitHub Actions** (`.github/workflows/scheduler.yml`, included): free. Add repo secrets `APP_URL` and `CRON_SECRET`. GitHub may delay scheduled runs by a few minutes, which is fine for posting.
   - **Vercel Cron**: needs a paid Vercel plan, because the free plan only allows crons that run once a day. Add a `vercel.json` at the project root (Vercel sends `Authorization: Bearer $CRON_SECRET` itself), and disable the GitHub workflow so jobs don't run twice:
     ```json
     { "crons": [
         { "path": "/api/cron/all", "schedule": "*/10 * * * *" },
         { "path": "/api/cron/comments", "schedule": "7 */3 * * *" },
         { "path": "/api/cron/autofill", "schedule": "13 11 * * *" } ] }
     ```

Jobs: `all` (publish + reshare, every 10 min), `comments` (every 3 h), `autofill` (daily). **Settings → Automatic posting → Check now** runs publish and reshare straight away; any job can also be run locally with `npm run job -- publish`.

If a publish run dies partway (serverless timeout, deploy, crash), the next `publish` run picks up any post that has been stuck in "Publishing…" for more than 15 minutes. If nothing had been sent to LinkedIn yet, the post is retried automatically (up to 3 attempts). If the request may have reached LinkedIn, the post is marked **Failed** instead of being retried, so it can't be posted twice. It's listed under **To do** at the top of the dashboard (with failed reshares) until someone checks the page and chooses **Mark posted** or **Retry**. If LinkedIn rejected the account's token, the item says **Reconnect to retry** instead, since a Retry would fail the same way. Each problem is explained in plain words. The dashboard never shows technical error text: it stays in the database (`posts.error`, `job_runs.summary`) and the server log for whoever runs the app. The same happens when LinkedIn accepts a post without returning its id, or the connection drops after the request went out. Errors where LinkedIn clearly said no, or no connection was made (DNS failure, connection refused), are still retried automatically.

Reshares work the same way: a reshare stuck in "Resharing…" is retried if nothing was sent, or marked failed (use **Mark shared** or **Retry**) if it may already be live.

## Upgrading an existing install

Migrations `002`–`009` only add things, so the running version keeps working after them, and the new version needs them. `010` removes columns that versions before the GitHub feature was taken out still use, so apply it after the new version is live:

```bash
npm run db:migrate -- --to=009   # 1. before deploying
#                                  2. deploy the new version
npm run db:migrate               # 3. after it's live (applies 010)
```

A new install just runs `npm run db:migrate` once.

## LinkedIn setup

LinkedIn splits posting into products with different approval levels:

| What | LinkedIn product | Scopes | Approval |
|---|---|---|---|
| Post and reshare as **your profile** | Share on LinkedIn + Sign In with LinkedIn using OpenID Connect | `openid profile w_member_social` | Self-serve, instant |
| Post as a **company page**, read its comments | Community Management API | `w_organization_social r_organization_social r_organization_social_feed rw_organization_admin` | Reviewed (expect 1–2+ weeks) |

Steps:

1. Create an app at <https://www.linkedin.com/developers/apps>, linked to your company page (a page admin must verify the link).
2. **Auth → Authorized redirect URLs**: add `https://YOUR-APP/api/auth/linkedin/callback` (and `http://localhost:3000/api/auth/linkedin/callback` for local).
3. **Products**: add *Sign In with LinkedIn using OpenID Connect* and *Share on LinkedIn* (instant).
4. Request **Community Management API**. LinkedIn asks for this on an app with no other API products, so you may need a second app just for it. They want a use-case description, privacy policy URL and, for the Standard tier, a screencast of each use case. This app is a good demo: approve, publish, reshare, read comments.
5. Put the client ID and secret in `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET`.
6. In the app: **Settings → Connect my profile** (works right away) and, once approved, **Connect company page**.

Until the company page is connected, company posts stay in "post by hand" mode and still get reminders, copy buttons and the reshare step.

Notes:
- Access tokens last 60 days. Apps with refresh tokens (granted to most Community Management API apps) are refreshed automatically; otherwise the app shows a banner a week before expiry so you can reconnect.
- `LINKEDIN_VERSION` is the monthly API version (`YYYYMM`). LinkedIn sunsets versions after about a year, so bump it once or twice a year.
- The company page's posts are made with the token of the admin who connected it.
- Reading comments on personal posts is restricted by LinkedIn, so comments sync only for company page posts.

## First live run (do this once)

The app was built and tested without access to LinkedIn (every LinkedIn step was checked against its documented responses), so check these once on your real accounts. Pick a quiet time, and delete the test posts from LinkedIn afterwards.

1. **Connect** the company page and your profile in Settings. Both should show their real names (not "Name missing"), and the page should say "auto-posting".
2. **A text post:** write a short draft, approve it for a few minutes from now, and after that time press **Settings → Automatic posting → Check now**. It should appear on the page, and the app should move it to Posted with a working **View post** link.
3. **The reshare:** about 3 hours later the founder's reshare goes out. It should appear on the profile, and the post's card should say "Reshared".
4. **A carousel:** turn a draft into a carousel with two points, press **Preview**, then approve and publish it the same way. On LinkedIn the slides should show the page's name and your carousel color.
5. If anything lands in **To do** instead, its message says what happened and what to do next.

## Drafting (optional)

Set `ANTHROPIC_API_KEY` (and `ANTHROPIC_MODEL` if you want a different model). Then:

- **Generate** in the Review section writes 1–6 drafts, with optional direction ("a carousel about a recent project"). About one in four is a carousel.
- **Rewrite** sends your note and the draft to Claude and puts the new version back in review.
- **autofill** (daily) keeps at least 6 drafts or planned posts in the pipeline.

All drafting follows the **voice and audience notes** in Settings plus built-in rules (no em dashes or buzzwords, inclusive language, varied length, no invented stats or quotes, never mentions AI). Nothing is ever published without your approval.

## Carousels

A carousel (LinkedIn "document post") either has an uploaded PDF or slide text (`posts.slides`). Write or change the slides in the draft with **Edit slides**, or turn a text draft into one with **Make it a carousel**: a cover, up to 10 numbered points (each can have a short quote), and a closing slide. The post text becomes the caption. If there's no PDF at publish time, one is built (1080×1350, `src/lib/carousel.ts`), headed on every slide with the name of the account that publishes it (LinkedIn's name for it, or the one you give it with **Rename** in Settings). An account is never named by its LinkedIn ID: if LinkedIn doesn't give a page's name when you connect it, it isn't added, and a reconnect keeps the name it has. Slides use the **Carousel color** from Settings (a neutral slate until you pick one); text turns light or dark to suit it, and in-between colors are deepened slightly, so slides stay readable. Add a `public/logo-mark.png` to show your logo next to the name (it's also used as the company page's picture in the dashboard), and Inter `.otf` files in `public/fonts/` for your own type; otherwise it uses Helvetica and no logo. Use **Preview PDF** to check it and **Upload your own PDF** to replace it.

## Data model

`workspaces` → `accounts` (LinkedIn identities; tokens AES-256-GCM encrypted with `APP_SECRET`) → `posts` (status: draft → planned → publishing → posted, or revise / failed / rejected; a post left in publishing is recovered, see Jobs above; reshare_status: none → pending → resharing → done/failed) → `comments`. `attachments` stores PDFs in Postgres. `job_runs` logs every scheduled run.

## Security

- Single admin password, signed HTTP-only session cookie (30 days), simple login throttling.
- Job endpoints accept either the admin session or `Authorization: Bearer CRON_SECRET`.
- LinkedIn tokens are encrypted at rest and never sent to the browser.
- OAuth uses a one-time `state` stored server-side.

## Sample data

`seed/example.json` holds a few sample posts for a fictional company. `npm run db:seed` imports them into an empty workspace, with both accounts in "post by hand" mode until you connect them.
