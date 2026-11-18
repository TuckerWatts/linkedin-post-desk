-- A name someone chose for the account in Settings. When set, it's shown instead of LinkedIn's name (accounts.name)
-- everywhere, including carousel headers. Reconnecting refreshes accounts.name but never touches this.
ALTER TABLE accounts ADD COLUMN display_name text;
