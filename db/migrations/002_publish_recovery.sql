-- Lets the publish job recover posts left in 'publishing' when the process dies mid-publish.
--   publish_claim       random token written on every claim; a worker may only finish a post it still holds.
--   publish_claimed_at  when the current claim was taken (stale claims are recovered).
--   publish_sent_at     set just before the create request goes to LinkedIn. If a claim goes stale with this
--                       set, the post may be live, so it is marked failed for a person to check instead of retried.
ALTER TABLE posts
  ADD COLUMN publish_claim      uuid,
  ADD COLUMN publish_claimed_at timestamptz,
  ADD COLUMN publish_sent_at    timestamptz;
