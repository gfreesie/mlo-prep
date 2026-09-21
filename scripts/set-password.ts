/* Reset the password for an existing account and invalidate every session.
 *
 *   npm run user:passwd -- her@example.com
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { db, now } from "../server/db.ts";
import { hashPassword, passwordProblem, userByEmail } from "../server/auth.ts";

const email = process.argv[2];
if (!email) {
  console.error("Usage: npm run user:passwd -- her@example.com");
  process.exit(1);
}
const user = userByEmail(email);
if (!user) {
  console.error(`No account for ${email}.`);
  process.exit(1);
}

const rl = createInterface({ input: stdin, output: stdout });
const password = await rl.question("New password (at least 10 characters): ");
const again = await rl.question("Confirm: ");
rl.close();

if (password !== again) {
  console.error("Passwords do not match.");
  process.exit(1);
}
const problem = passwordProblem(password);
if (problem) {
  console.error(problem);
  process.exit(1);
}

const hash = await hashPassword(password);
const tx = db.transaction(() => {
  db.prepare("UPDATE users SET pwHash=? WHERE id=?").run(hash, user.id);
  // a password change should log every device out
  db.prepare("DELETE FROM sessions WHERE userId=?").run(user.id);
});
tx();

console.log(`Password updated for ${user.email} at ${now()}. All sessions signed out.`);
db.close();
