# Post Desk

Plan, approve, publish and reshare LinkedIn posts for a company page and its founder.

- **Review drafts** one at a time, with a checker that flags wording that reads as AI-written (em dashes, buzzwords, hashtag spam, links).
- **Approve & plan**: each draft gets a suggested time that looks human (2–3 days apart, uneven minutes, mostly weekdays).
- **Auto-publish** to the company page through LinkedIn's API, including **carousel (PDF document) posts** built from slide text in your brand.
- **Auto-reshare** each company post from the founder's profile a few hours later, with a short personal note.
- **Comments** on company posts are pulled in so you can reply on LinkedIn yourself.
- **Drafting with Claude** (optional): keeps the pipeline full, rewrites drafts from your notes, and writes a weekly "what we shipped" post from merged GitHub pull requests.
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
npm test
```

Generate secrets with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

## Deploy (Vercel + Neon, or anything that runs Next.js)

1. Create a Postgres database (Neon, Supabase, Railway…) and run `npm run db:migrate` against it.
2. Import the repo into Vercel and set the variables from `.env.example`. `APP_URL` must be the deployed URL.
3. Pick **one** scheduler:
   - **Vercel Cron** (`vercel.json`): needs a paid Vercel plan for the 10-minute publish job. Vercel sends `Authorization: Bearer $CRON_SECRET` automatically.
   - **GitHub Actions** (`.github/workflows/scheduler.yml`): free. Add repo secrets `APP_URL` and `CRON_SECRET`. GitHub may delay scheduled runs by a few minutes, which is fine for posting. Delete `vercel.json` crons if you use this.

Jobs: `all` (publish + reshare, every 10 min), `comments` (every 3 h), `autofill` (daily), `weekly-draft` (Mondays). You can also run any job from **Settings → Automation → Run now**, or locally with `npm run job -- publish`.

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

## Drafting (optional)

Set `ANTHROPIC_API_KEY` (and `ANTHROPIC_MODEL` if you want a different model). Then:

- **Generate** in the Review section writes 1–6 drafts, with optional direction ("a carousel about staffing"). About one in four is a carousel.
- **Rewrite** sends your note and the draft to Claude and puts the new version back in review.
- **autofill** (daily) keeps at least 6 drafts or planned posts in the pipeline.
- **weekly-draft** (Mondays) reads PRs merged in the last 7 days from `GITHUB_REPO` using a read-only `GITHUB_TOKEN` (fine-grained PAT: *Contents* and *Pull requests* read). It picks the one change a customer would notice, skips refactors, security fixes and unreleased work, and never reuses a PR.

All drafting follows the **voice and audience notes** in Settings plus built-in rules (no em dashes or buzzwords, inclusive language, varied length, no invented stats or quotes, never mentions AI). Nothing is ever published without your approval.

## Carousels

A document post either has an uploaded PDF or slide text (`posts.slides`). If there's no PDF at publish time, one is built in the default brand (`src/lib/carousel.ts`: teal and greens, 1080×1350). Drop Inter `.otf` files into `public/fonts/` and a `public/logo-mark.png` to use your own type and logo; otherwise it falls back to Helvetica. Use **Preview PDF** to check it and **Upload your own PDF** to replace it.

## Data model

`workspaces` → `accounts` (LinkedIn identities; tokens AES-256-GCM encrypted with `APP_SECRET`) → `posts` (status: draft → planned → publishing → posted, or revise / failed / rejected; reshare_status: none → pending → done/failed) → `comments`. `attachments` stores PDFs in Postgres. `job_runs` logs every scheduled run.

## Security

- Single admin password, signed HTTP-only session cookie (30 days), simple login throttling.
- Job endpoints accept either the admin session or `Authorization: Bearer CRON_SECRET`.
- LinkedIn tokens are encrypted at rest and never sent to the browser.
- OAuth uses a one-time `state` stored server-side.

## Turning it into a product

Already in place: workspace scoping, per-account tokens, manual mode, branded carousels per workspace (move `BRAND` into the workspace row). Still to build:

- Sign-up and multi-user auth (replace the single password with email login), workspace switcher.
- Billing (Stripe) and plan limits.
- Per-workspace brand settings (colors, fonts, logo upload) for carousels.
- LinkedIn's multi-tenant review: Community Management API approval for an app that connects other companies' pages requires showing data isolation between tenants.

## Sample data

`seed/example.json` holds a few sample posts for a fictional company. `npm run db:seed` imports them into an empty workspace, with both accounts in "post by hand" mode until you connect them.
