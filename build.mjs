/* Build the self-hosted site into dist/.
 *
 * index.html at the repo root is written for the Artifact host, which supplies
 * its own <!doctype>/<head>/<body> wrapper and a small reset. Self-hosting gets
 * none of that, so this script produces a complete standalone document:
 *
 *   - real doctype/html/head/body, charset, viewport, favicon, social tags
 *   - the reset the Artifact wrapper used to provide (body margin, img sizing)
 *   - inline <style> and <script> extracted to app.css / app.js, so the server
 *     can ship a CSP without 'unsafe-inline'
 *   - sync.js included, which the Artifact build deliberately omits
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

/* Two targets:
 *   node build.mjs                      -> dist/  with sync.js   (droplet)
 *   node build.mjs --static --out docs  -> docs/  without sync.js (GitHub Pages)
 * Pages has no server, so shipping sync.js there would show a "Sign in to sync"
 * control that can never work. The static build omits it entirely. */
const argv = process.argv.slice(2);
const STATIC = argv.includes("--static");
const outIdx = argv.indexOf("--out");
const outName = outIdx >= 0 ? argv[outIdx + 1] : "dist";

const root = resolve(".");
const dist = resolve("./" + outName);
const TITLE = "The Underwriting Desk";
const DESC =
  "SAFE MLO exam prep: 500 explained questions, timed mock exams at real blueprint weights, and a study plan built around your weakest domains.";

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const src = readFileSync(join(root, "index.html"), "utf8");

/* ---- split the single-file source into head assets and body ---- */
const styleMatch = src.match(/<style>([\s\S]*?)<\/style>/);
if (!styleMatch) throw new Error("No <style> block found in index.html");
const css = styleMatch[1];

// the app's own logic is the last inline <script> (the bank files are src= tags)
const inlineScripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (!inlineScripts.length) throw new Error("No inline <script> found in index.html");
const appJs = inlineScripts[inlineScripts.length - 1][1];

const bodyStart = src.indexOf("<header");
if (bodyStart < 0) throw new Error("No <header> found in index.html");
let body = src.slice(bodyStart);
// strip every script tag, with or without attributes - they are re-added below
// in a controlled order. Missing the src= ones here loads the bank twice.
body = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "").trimEnd();

const fontLinks = [...src.matchAll(/<link[^>]*>/g)].map((m) => m[0]).join("\n");
const bankTags = [...src.matchAll(/<script src="(bank-[^"]+)"><\/script>/g)].map((m) => m[1]);
if (!bankTags.length) throw new Error("No bank-*.js script tags found");

/* a pen nib, matching the artifact's favicon, as an inline SVG data URI */
const favicon =
  "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%20100%20100'%3E" +
  "%3Crect%20width='100'%20height='100'%20rx='18'%20fill='%238C2F2A'/%3E" +
  "%3Ctext%20x='50'%20y='72'%20font-size='62'%20font-family='Georgia,serif'%20font-weight='bold'" +
  "%20fill='%23F2F3F0'%20text-anchor='middle'%3ED%3C/text%3E%3C/svg%3E";

const reset = `
/* reset the Artifact host used to supply */
html{color-scheme:light dark}
body{margin:0}
img{max-width:100%}
[hidden]{display:none!important}
`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${TITLE}</title>
<meta name="description" content="${DESC}">
${STATIC ? "" : `<meta name="robots" content="noindex, nofollow">`}
<meta name="theme-color" content="#F2F3F0" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#141613" media="(prefers-color-scheme: dark)">
<meta property="og:title" content="${TITLE}">
<meta property="og:description" content="${DESC}">
<meta property="og:type" content="website">
<link rel="icon" href="${favicon}">
<link rel="apple-touch-icon" href="${favicon}">
${fontLinks}
<link rel="stylesheet" href="app.css">
</head>
<body>
${body}
${bankTags.map((b) => `<script src="${b}"></script>`).join("\n")}
<script src="feedback.js"></script>
${STATIC ? "" : '<script src="sync.js"></script>'}
<script src="app.js"></script>
</body>
</html>
`;

writeFileSync(join(dist, "index.html"), html, "ascii");
writeFileSync(join(dist, "app.css"), reset + css, "ascii");
writeFileSync(join(dist, "app.js"), appJs, "ascii");
copyFileSync(join(root, "feedback.js"), join(dist, "feedback.js"));
if (!STATIC) copyFileSync(join(root, "sync.js"), join(dist, "sync.js"));
for (const b of bankTags) copyFileSync(join(root, b), join(dist, b));
writeFileSync(join(dist, "robots.txt"), STATIC ? "User-agent: *\nAllow: /\n" : "User-agent: *\nDisallow: /\n", "ascii");
// .nojekyll stops Pages running the output through Jekyll, which would
// otherwise ignore files beginning with an underscore and add a build step
if (STATIC) writeFileSync(join(dist, ".nojekyll"), "", "ascii");

/* ---- report ---- */
const files = readdirSync(dist).sort();
let total = 0;
console.log(`built ${outName}/ (${STATIC ? "static, no sync" : "server build, with sync"})`);
for (const f of files) {
  const bytes = readFileSync(join(dist, f)).length;
  total += bytes;
  console.log(`  ${f.padEnd(14)} ${(bytes / 1024).toFixed(1).padStart(7)} KB`);
}
console.log(`  ${"total".padEnd(14)} ${(total / 1024).toFixed(1).padStart(7)} KB`);

/* ---- guard: the whole point of asciifying is that this stays true ---- */
for (const f of files) {
  const buf = readFileSync(join(dist, f));
  const bad = buf.findIndex((b) => b > 127);
  if (bad >= 0) {
    throw new Error(
      `${f} contains a non-ASCII byte at offset ${bad}. Use \\uXXXX escapes in JS string literals instead - raw UTF-8 mojibakes when served without a charset.`,
    );
  }
}
console.log("all output is pure ASCII");
