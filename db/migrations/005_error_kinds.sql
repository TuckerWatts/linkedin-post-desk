-- What sort of problem error / reshare_error describe (see ErrorKind in src/lib/explain.ts), so the dashboard can
-- explain it in plain words and keep the technical message as details. NULL for rows from before this existed;
-- the dashboard then shows the message as it is.
ALTER TABLE posts
  ADD COLUMN error_kind         text,
  ADD COLUMN reshare_error_kind text;
