-- Set when LinkedIn rejects an account's token (401), so the dashboard can say "Reconnect" instead of offering a
-- Retry that would fail the same way. Cleared when the account is reconnected or its token is refreshed.
ALTER TABLE accounts ADD COLUMN reconnect_needed_at timestamptz;
