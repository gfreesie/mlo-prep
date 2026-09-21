/* Create the account from the server, so a password never travels over HTTP
 * before TLS is up and signups can stay closed.
 *
 *   npm run user:create -- her@example.com
 *
 * Prompts for the password rather than taking it as an argument, which would
 * leave it in shell history and in `ps`.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { db } from "../server/db.ts";
import {
  createUser,
  emailProblem,
  passwordProblem,
  userByEmail,
  userCount,
} from "../server/auth.ts";

const email = process.argv[2];
const problem = emailProblem(email);
if (problem) {
  console.error(problem + "\nUsage: npm run user:create -- her@example.com");
  process.exit(1);
}
if (userByEmail(email!)) {
  console.error(`${email} already exists. Use \`npm run user:passwd -- ${email}\` to change the password.`);
  process.exit(1);
}

const rl = createInterface({ input: stdin, output: stdout });
const password = await rl.question("Password (at least 10 characters): ");
const again = await rl.question("Confirm: ");
rl.close();

if (password !== again) {
  console.error("Passwords do not match.");
  process.exit(1);
}
const pwProblem = passwordProblem(password);
if (pwProblem) {
  console.error(pwProblem);
  process.exit(1);
}

await createUser(email!, password);
console.log(`Created ${email!.trim().toLowerCase()}. Accounts on this server: ${userCount()}`);
db.close();
