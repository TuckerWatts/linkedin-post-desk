-- The times of day new drafts are suggested for (see POSTING_WINDOWS in src/lib/slots.ts). Chosen in Settings.
-- Replaces a fixed list of times that leaned towards early mornings.
ALTER TABLE workspaces ADD COLUMN posting_windows text[] NOT NULL DEFAULT '{morning,midday}';
