-- The weekly "what we shipped" GitHub feature was removed; nothing reads or writes these any more.
-- Apply only once the version without that feature is live: earlier versions read workspaces.github_repo on every
-- request and write posts.source_refs when creating drafts. See "Upgrading" in the README.
ALTER TABLE workspaces DROP COLUMN IF EXISTS github_repo;
ALTER TABLE posts DROP COLUMN IF EXISTS source_refs;
