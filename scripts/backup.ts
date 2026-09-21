/* Consistent backup of the SQLite database.
 *
 *   npm run backup                 -> ./backups/mloprep-<timestamp>.sqlite
 *   BACKUP_DIR=/var/backups/mlo npm run backup
 *
 * Uses SQLite's online backup API rather than copying the file, so it is safe
 * while the server is running and mid-write. Copying a WAL database with `cp`
 * can capture a torn state; this cannot.
 */
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { db, databasePath } from "../server/db.ts";

const dir = resolve(process.env.BACKUP_DIR || "./backups");
const keep = Number(process.env.BACKUP_KEEP || 14);
mkdirSync(dir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const target = join(dir, `mloprep-${stamp}.sqlite`);

await db.backup(target);
const size = statSync(target).size;
console.log(`backed up ${databasePath} -> ${target} (${(size / 1024).toFixed(1)} KB)`);

/* retention */
const old = readdirSync(dir)
  .filter((f) => /^mloprep-.*\.sqlite$/.test(f))
  .sort()
  .reverse()
  .slice(keep);
for (const f of old) {
  unlinkSync(join(dir, f));
  console.log(`  pruned ${f}`);
}
if (old.length) console.log(`keeping the ${keep} most recent backups`);

db.close();
