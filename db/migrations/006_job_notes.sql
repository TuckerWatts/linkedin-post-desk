-- A short plain-language result per job run, for the dashboard. summary stays the technical log for operators.
ALTER TABLE job_runs ADD COLUMN note text;
