// Run a scheduled job from the command line:  npm run job -- publish
import { runJob, JOBS, type JobName } from "../src/lib/jobs";
import { pool } from "../src/lib/db";

const name = process.argv[2] as JobName;
if (!JOBS.includes(name)) {
  console.error(`Usage: npm run job -- <${JOBS.join("|")}>`);
  process.exit(1);
}
runJob(name)
  .then((r) => { console.log(r); return pool().end(); })
  .catch((e) => { console.error(e); process.exit(1); });
