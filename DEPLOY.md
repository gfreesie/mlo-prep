# Deploying studyprep.ssopros.com

The app is a static study front-end plus a small Express + SQLite server that
syncs progress between devices. Node serves both, and nginx sits in front of it
as a TLS terminator.

Everything below is one-time except **Step 5**, which you repeat for each update.

---

## Before you start: the DNS situation

`ssopros.com` uses **Google Cloud DNS** (`ns-cloud-c*.googledomains.com`), not
DigitalOcean. Two things are true right now that matter:

- There is a **wildcard record**: `*.ssopros.com -> 64.225.114.22`. That is why
  `studyprep.ssopros.com` already "resolves" even though nothing is there.
- `64.225.114.22` is **unreachable** - no ping, no 22, no 80, no 443. It looks
  like a destroyed droplet whose DNS was never cleaned up.

A specific `A` record for `studyprep` beats the wildcard, so you do not have to
remove the wildcard to make this work.

> **Separately:** the same wildcard is almost certainly breaking
> `nelli.ssopros.com`. Nelli deploys to GitHub Pages and is healthy at
> `gfreesie.github.io/nelli/`, but there is no `CNAME` record for `nelli`, so the
> wildcard sends the domain to the dead IP instead. Adding
> `CNAME nelli -> gfreesie.github.io.` fixes it. You asked me to leave Nelli
> alone, so I have - this is a note, not a change.

---

## Step 1 - Create the droplet

In the DigitalOcean panel:

| Setting | Value |
|---|---|
| Image | Ubuntu 24.04 (LTS) x64 |
| Plan | Basic / Regular / **$6/mo** (1 GB / 1 vCPU / 25 GB) |
| Datacenter | Whichever is closest to her |
| Authentication | **SSH key** - select your existing key, not a password |
| Hostname | `studyprep` |

1 GB is ample: the whole site is ~300 KB and SQLite is a single file.

Copy the droplet's IP when it finishes provisioning.

## Step 2 - Point DNS at it

In **Google Cloud DNS**, in the `ssopros.com` zone, add:

```
Name:  studyprep
Type:  A
TTL:   300
Data:  <your droplet IP>
```

Confirm it took effect before continuing - the TLS step fails if DNS is wrong:

```bash
nslookup studyprep.ssopros.com 8.8.8.8
```

You want your droplet's IP back, not `64.225.114.22`.

## Step 3 - Provision the server

```bash
scp "deploy/setup.sh" "deploy/nginx.conf" "deploy/mlo-prep.service" root@<IP>:/root/
ssh root@<IP> "bash /root/setup.sh"
```

The script is idempotent - safe to re-run. It installs Node 22, nginx, ufw,
fail2ban and unattended-upgrades; creates a `mloprep` service account and a
`deploy` user; sets up the systemd unit and a nightly backup timer; and requests
the Let's Encrypt certificate. It checks DNS first and offers to skip TLS if the
record has not propagated, so you can re-run just that part later.

It will ask for an email address for certificate expiry notices. That address
goes to Let's Encrypt, so use whichever you want those warnings at.

## Step 4 - First deploy

From the `MLO Prep` directory on your machine:

```bash
./deploy/deploy.sh <IP>
```

This builds `dist/`, uploads the app, installs production dependencies, swaps
the new release into place atomically, restarts the service and health-checks it.

## Step 5 - Create her account

Signups close automatically once one account exists, so there is a choice here:

**Either** let her sign up herself - send her the link and she creates the
account on first visit, and the door closes behind her.

**Or** create it yourself from the server, which never puts a password in a
browser form:

```bash
ssh deploy@<IP>
cd /srv/mlo-prep/current
npm run user:create -- her@example.com
```

It prompts for the password twice and does not accept it as an argument, so it
stays out of shell history.

Done. `https://studyprep.ssopros.com`

---

## Updating it later

```bash
./deploy/deploy.sh <IP>
```

That is the whole loop. Questions, styling, plan logic - edit the files, run it.

**Rollback**, if a deploy goes wrong:

```bash
ssh deploy@<IP> "cd /srv/mlo-prep && rm -rf current && mv release.old current && sudo systemctl restart mlo-prep"
```

---

## Operations

| Task | Command |
|---|---|
| Service status | `ssh deploy@<IP> "systemctl status mlo-prep"` |
| Live logs | `ssh deploy@<IP> "journalctl -u mlo-prep -f"` |
| Restart | `ssh deploy@<IP> "sudo systemctl restart mlo-prep"` |
| Health check | `curl https://studyprep.ssopros.com/healthz` |
| Backup now | `ssh deploy@<IP> "cd /srv/mlo-prep/current && npm run backup"` |
| List backups | `ssh deploy@<IP> "ls -lh /srv/mlo-prep/backups"` |
| Reset her password | `ssh deploy@<IP> "cd /srv/mlo-prep/current && npm run user:passwd -- her@example.com"` |
| Pull the database down | `scp deploy@<IP>:/srv/mlo-prep/data/mloprep.sqlite ./` |

Backups run nightly via `mlo-prep-backup.timer` and keep the last 14. They use
SQLite's online backup API rather than `cp`, so they are consistent even if she
is answering a question at the time.

TLS renews automatically via certbot's timer. Check it with
`systemctl list-timers certbot.timer`.

---

## How the sync works

`localStorage` stays the working copy, so the app behaves identically with no
network - she can study on a plane. Every answer is also appended to a local
outbox and flushed to the server when it can be reached. The account chip in the
header shows the state: `Synced`, `Syncing`, or `Offline - N queued`.

Attempts are an **append-only log** with a client-generated id, which makes
re-sending harmless and lets two devices converge without conflict resolution.
The server replays that log to derive mastery, so there is exactly one
implementation of rules like "a question clears the Missed list after two
consecutive correct answers" - the client and server cannot drift apart.

Mock exams merge by id. The study plan is last-write-wins on `updatedAt`, which
is the right trade for a single user with two devices.

### Things worth knowing

- **Progress on the published Artifact does not transfer.** `localStorage` is
  per-origin, so whatever she has done at the `claude.ai/artifact/...` link stays
  there. If she has already been studying, either let her finish on that link or
  accept the reset. There is no migration path that does not involve me writing
  an importer - say the word if you want one.
- **Signed-out still works.** The whole app runs without an account; sync is
  additive. If the server is down she loses sync, not the app.
- **One account only.** `ALLOW_SIGNUP` in the systemd unit plus the
  "one user max" check keep the door shut. To open it up later for real
  students, that check in `server/index.ts` is the thing to change - and at that
  point the schema needs an `orgId`, which is a bigger conversation.

---

## Local development

```bash
npm install
cp .env.example .env
npm run dev            # builds dist/ and runs the server with watch
npm run smoke          # 30 end-to-end API tests against a running server
```

The smoke suite wants a throwaway database:

```bash
PORT=8789 DATABASE_PATH=./data/smoke.sqlite npx tsx server/index.ts
node scripts/smoke.mjs
```

## Layout

```
index.html        single-file app - also the source for the Artifact build
bank-*.js         500 questions + 52 flashcards
sync.js           offline-first sync client (self-hosted build only)
build.mjs         wraps index.html into a standalone document in dist/
server/           db.ts (schema + replay), auth.ts (scrypt + sessions), index.ts (API)
scripts/          create-user, set-password, backup, smoke
deploy/           setup.sh, deploy.sh, nginx.conf, mlo-prep.service
```

`index.html` is written for the Artifact host, which supplies its own
`<head>`/`<body>` wrapper. `build.mjs` produces the standalone version: real
doctype and charset, inline CSS and JS extracted to `app.css`/`app.js` so the
server can ship a CSP without `unsafe-inline` on scripts, and `sync.js` added.

All source files are kept **pure ASCII** on purpose - raw UTF-8 mojibakes when
served without a charset declaration. Use `\uXXXX` escapes in string literals.
`build.mjs` fails the build if a non-ASCII byte sneaks in.
