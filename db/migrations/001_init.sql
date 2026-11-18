-- Post Desk schema. One workspace today; every table is scoped by workspace_id so it can serve many companies later.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE workspaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  timezone    text NOT NULL DEFAULT 'America/New_York',
  voice       text NOT NULL DEFAULT '',
  github_repo text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A LinkedIn identity we can post as: a member (person) or an organization page.
CREATE TABLE accounts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('person', 'organization')),
  urn               text NOT NULL,
  name              text NOT NULL,
  profile_url       text,
  -- Tokens are AES-256-GCM encrypted with APP_SECRET. Org accounts use the token of the admin who connected them.
  access_token_enc  text,
  refresh_token_enc text,
  token_expires_at  timestamptz,
  is_default        boolean NOT NULL DEFAULT false,
  is_reshare_default boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, urn)
);

CREATE TABLE attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  filename      text NOT NULL,
  content_type  text NOT NULL,
  size_bytes    integer NOT NULL,
  data          bytea NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE posts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id         uuid REFERENCES accounts(id) ON DELETE SET NULL,
  status             text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'revise', 'planned', 'publishing', 'posted', 'failed', 'rejected')),
  topic              text NOT NULL DEFAULT '',
  body               text NOT NULL DEFAULT '',
  note               text,                       -- feedback for the next rewrite
  format             text NOT NULL DEFAULT 'text' CHECK (format IN ('text', 'document')),
  doc_title          text,
  slides             jsonb,                      -- carousel content used to build the PDF
  attachment_id      uuid REFERENCES attachments(id) ON DELETE SET NULL,
  suggested_for      timestamptz,
  scheduled_for      timestamptz,
  posted_at          timestamptz,
  linkedin_urn       text,
  url                text,
  error              text,
  attempts           integer NOT NULL DEFAULT 0,
  -- Personal reshare of a company post
  share_note         text,
  reshare_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  reshare_delay_min  integer NOT NULL DEFAULT 180,
  reshare_status     text NOT NULL DEFAULT 'none' CHECK (reshare_status IN ('none', 'pending', 'done', 'failed', 'skipped')),
  reshare_at         timestamptz,
  reshare_urn        text,
  reshare_error      text,
  source             text NOT NULL DEFAULT 'manual',   -- manual | generated | github | import
  source_refs        text[] NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX posts_due_idx ON posts (status, scheduled_for);
CREATE INDEX posts_reshare_idx ON posts (reshare_status, reshare_at);
CREATE INDEX posts_workspace_idx ON posts (workspace_id, created_at DESC);

CREATE TABLE comments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id       uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  linkedin_id   text NOT NULL UNIQUE,
  author_urn    text,
  author_name   text,
  text          text NOT NULL,
  commented_at  timestamptz,
  replied       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comments_post_idx ON comments (post_id);

CREATE TABLE oauth_states (
  state       text PRIMARY KEY,
  kind        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE job_runs (
  id          bigserial PRIMARY KEY,
  job         text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ok          boolean,
  summary     text
);
