# linkedin-sync tools

## Handoff command (handoff_urls.py)

`handoff_urls.py` takes the URLs of newly published LinkedIn articles and gets
them onto the site without you touching the droplet. In order, it:

1. Validates every URL (`https://www.linkedin.com/pulse/<slug>`; query string,
   fragment and trailing slash are dropped). If `--owner-check PATH` is given,
   each URL must also appear in that file (one URL per line, `#` comments ok).
   One bad URL rejects the whole run and nothing is written.
2. Checks the clone is clean and not behind `origin/main`.
3. Appends the URLs not already listed to `linkedin-sync/article-urls.txt`.
4. Commits and pushes to `origin/main`.
5. Runs the droplet sync over SSH (`sync-from-git.sh`).

Status messages go to stderr. Stdout is one JSON line:
`{"added": [...], "committed": bool, "synced": bool}`.

### Usage

```sh
# one URL
python3 linkedin-sync/tools/handoff_urls.py https://www.linkedin.com/pulse/example-article-slug/

# several at once
python3 linkedin-sync/tools/handoff_urls.py \
  https://www.linkedin.com/pulse/example-article-one/ \
  https://www.linkedin.com/pulse/example-article-two/

# only accept URLs listed in a file kept outside the repo
python3 linkedin-sync/tools/handoff_urls.py --owner-check <path-to-owner-list> \
  https://www.linkedin.com/pulse/example-article-slug/

# run against a specific clone
python3 linkedin-sync/tools/handoff_urls.py --repo <path-to-clone> \
  https://www.linkedin.com/pulse/example-article-slug/
```

Running it again with a URL that is already listed is harmless: it prints
`no new URLs to add`, exits 0, and changes nothing.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | OK, or idempotent (nothing new to add) |
| 2 | Invalid URL, owner-check rejection, or unreadable owner-check file. No changes made |
| 3 | Clone is dirty, behind `origin/main`, or the fetch/status check failed. No changes made |
| 4 | Commit or push failed |
| 5 | SSH sync failed, timed out, or the environment variables below are not set |

### Environment variables

Keep these outside the repo (for example in a file your shell or launchd job
sources). Never commit real values.

| Variable | Value |
|----------|-------|
| `MOTETHANSEN_DROPLET_SSH` | An SSH host alias defined in `~/.ssh/config` (not a raw hostname) |
| `MOTETHANSEN_SYNC_CMD` | The remote command that runs the sync, e.g. `bash <absolute-path-to-checkout-on-droplet>/linkedin-sync/deploy/sync-from-git.sh` |

`sync-from-git.sh` accepts `--no-build` and `--dry-run`, and it resolves the
checkout from its own location (or `$SYNC_REPO`), so running it by absolute
path is enough. It does `git reset --hard origin/main` on the droplet checkout
and then rebuilds the `sync` image, so only run it where that is intended.

### One-time setup checklist

**(a) GitHub deploy key (push access from the mini)**

- [ ] Generate a key with no passphrase, so it works unattended:
      `ssh-keygen -t ed25519 -f ~/.ssh/<deploy-key-name> -N "" -C "mini-handoff-deploy"`
- [ ] In the GitHub repo: Settings > Deploy keys > Add deploy key. Paste the
      `.pub` file and tick **Allow write access**. A deploy key is limited to
      this one repository.
- [ ] Add a Host alias for github.com to `~/.ssh/config` on the mini:
      ```
      Host <github-alias>
          HostName github.com
          User git
          IdentityFile ~/.ssh/<deploy-key-name>
          IdentitiesOnly yes
      ```
- [ ] Point the clone's origin at the alias:
      `git remote set-url origin git@<github-alias>:<owner>/<repo>.git`
- [ ] Check: `ssh -o BatchMode=yes -T git@<github-alias>` greets you, and
      `git fetch origin` works in the clone.

**(b) Dedicated key for the mini to reach the droplet, with a forced command**

- [ ] On the mini: `ssh-keygen -t ed25519 -f ~/.ssh/<droplet-key-name> -N "" -C "mini-handoff"`
- [ ] On the droplet, add one line to the target user's `~/.ssh/authorized_keys`
      (the public key from the previous step), in this shape:
      ```
      command="<absolute path to sync-from-git.sh>",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA...placeholder mini-handoff
      ```
      With this line the key can only run that script, whatever the client asks for.

**(c) SSH config block on the mini for the droplet**

- [ ] Add to `~/.ssh/config`:
      ```
      Host <alias>
          HostName <droplet-host>
          User <user>
          IdentityFile ~/.ssh/<droplet-key-name>
          IdentitiesOnly yes
      ```
- [ ] Set `MOTETHANSEN_DROPLET_SSH=<alias>` and `MOTETHANSEN_SYNC_CMD` in your environment file.

**(d) Test without a terminal**

- [ ] Connectivity and key acceptance only (this runs the forced script, since
      the forced command replaces `true`):
      `ssh -o BatchMode=yes <alias> true`
      A non-zero exit or a password/host-key prompt means the key, alias, or
      `known_hosts` entry is wrong. Run `ssh <alias>` once interactively to
      accept the host key first.
- [ ] Dry run of the whole command with no real URL: pass an already-listed
      URL. It exits 0 with `no new URLs to add` and touches nothing, which
      proves validation, the clone guard, and the owner check. The SSH step is
      skipped in that case, so also run the check above.
- [ ] Because a forced command ignores the requested command, the client cannot
      pass `--dry-run` through it, and `MOTETHANSEN_SYNC_CMD` may be any
      non-empty string (the forced script runs regardless). To dry-run the
      sync itself, run `bash <path>/sync-from-git.sh --dry-run` on the droplet.

### Failure recovery

**Exit 3 (guard).** Nothing was changed. Clean up the clone
(`git status`; commit or stash your edits) and/or `git pull --ff-only`, then re-run.

**Exit 4 (commit or push failed).** The URL file may already be edited and
committed locally, but `origin/main` does not have it. The tool does not retry
beyond one `git pull --rebase` (aborted on conflict) and never force-pushes.

1. In the clone, run `git status` and `git log origin/main..HEAD`.
2. If the commit is there: `git pull --rebase origin main`, resolve any
   conflict in `article-urls.txt` (keep every URL line from both sides), then
   `git push origin HEAD:main`.
3. If the commit failed and the file is only modified: inspect
   `git diff linkedin-sync/article-urls.txt`, then commit and push by hand, or
   `git restore linkedin-sync/article-urls.txt` and re-run.
4. Run the sync step by hand (below), or just re-run the tool: it will say
   `no new URLs to add` and exit 0, so use the manual sync instead.

**Exit 5 (SSH sync failed).** The URL **is already pushed** to `origin/main`
and is safe. Only the droplet is stale. Fix the cause (variables unset, key or
alias wrong, timeout of 300 s, remote script error) and then either:

- run the sync by hand: `ssh -o BatchMode=yes <alias> <any-string>`, or
- log in to the droplet and run `bash <path>/sync-from-git.sh`.

Re-running the tool does not retry the sync, because the URL is already listed.
The droplet's own `git fetch` plus `reset --hard origin/main` also picks the
URL up on its next scheduled sync.
