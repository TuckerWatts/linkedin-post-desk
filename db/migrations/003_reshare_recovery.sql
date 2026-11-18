-- Same recovery as 002, for reshares. A reshare used to be marked 'done' before LinkedIn was called, so a run that
-- died mid-reshare showed "Reshared" for a reshare that never happened. It now sits in 'resharing' while in flight.
--   reshare_attempts  claims so far; a reshare whose runs keep dying before sending gives up after 3.
--   reshare_claim, reshare_claimed_at, reshare_sent_at  work like publish_claim, publish_claimed_at, publish_sent_at.
ALTER TABLE posts DROP CONSTRAINT posts_reshare_status_check;
ALTER TABLE posts ADD CONSTRAINT posts_reshare_status_check
  CHECK (reshare_status IN ('none', 'pending', 'resharing', 'done', 'failed', 'skipped'));
ALTER TABLE posts
  ADD COLUMN reshare_attempts   integer NOT NULL DEFAULT 0,
  ADD COLUMN reshare_claim      uuid,
  ADD COLUMN reshare_claimed_at timestamptz,
  ADD COLUMN reshare_sent_at    timestamptz;
