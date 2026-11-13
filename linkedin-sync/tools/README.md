# linkedin-sync tools

## Handoff command (handoff_urls.py)

`handoff_urls.py` takes the URLs of newly published LinkedIn articles and gets
them onto the site without you touching the droplet. In order, it:

1. Validates every URL (`https://www.linkedin.com/pulse/<slug>`; query string,
   fragment and trailing slash are dropped). If `--owner-check PATH` is given,
   each URL must also appear in that file (one URL per line, `#` comments ok).
   One bad URL rejects the whole run and nothing is written.
2. Checks the clone is clean, on the branch `main`, and that local `main` is
   exactly `origin/main` (fetched first). Anything else is refused, so the push
   can only ever publish this command's own commit.
3. Appends the URLs not already listed to `linkedin-sync/article-urls.txt`.
4. Commits and runs `git push origin main`. One commit, no retry, no rebase.
5. Runs the droplet sync over SSH (`sync-from-git.sh`).

Status messages go to stderr, including anything the remote sync script prints.
Stdout is exactly one JSON line:
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
| 3 | Clone is dirty, not on `main`, local `main` differs from `origin/main`, or the fetch/status check failed. No changes made |
| 4 | Commit or push failed (the message names the step) |
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
(`git status`; commit or stash your edits), `git checkout main`, and make it
equal to `origin/main` (`git pull --ff-only` if behind; if it is ahead, push or
move those commits elsewhere first), then re-run.

**Exit 4 (commit or push failed).** The URL file may already be edited and
committed locally, but `origin/main` does not have it. The tool does not retry,
rebase or rewrite anything, and never force-pushes; the stderr message says
whether `git add`, `git commit` or `git push` failed.

1. In the clone, run `git status` and `git log origin/main..HEAD`.
2. If the commit is there and `git fetch origin` shows `origin/main` has not
   moved: fix the cause of the push error and run `git push origin main`.
   If `origin/main` has moved, `git pull --rebase origin main`, resolve any
   conflict in `article-urls.txt` (keep every URL line from both sides), then
   `git push origin main`.
3. If the commit failed and the file is only modified: inspect
   `git diff linkedin-sync/article-urls.txt`, then commit and push by hand, or
   `git restore linkedin-sync/article-urls.txt` and re-run.
4. Then run the sync step (see exit 5). Re-running the tool is not enough once
   the URL is listed: it says `no new URLs to add` and does not call SSH.

**Exit 5 (SSH sync failed).** The URL **is committed and pushed** to
`origin/main`, so it is safe in git, but it is **not yet on the droplet**. The
droplet only changes when `sync-from-git.sh` runs there; the checked-in
scheduler (`deploy/docker-run.sh` via the systemd timer) only runs the container
and does not fetch or reset the checkout, so waiting will not deliver it. Fix
the cause (variables unset, key or alias wrong, timeout of 300 s, remote script
error), then re-run the same SSH command the tool uses. It is idempotent
(`sync-from-git.sh` resets the droplet to `origin/main` and rebuilds):

```sh
ssh -o BatchMode=yes "$MOTETHANSEN_DROPLET_SSH" $MOTETHANSEN_SYNC_CMD
```

(Unquoted `$MOTETHANSEN_SYNC_CMD` on purpose: it is split into words, as the
tool does. With the forced command from the setup checklist the server runs the
script regardless of what is passed.) Or log in to the droplet and run
`bash <path>/sync-from-git.sh`.

Re-running `handoff_urls.py` itself does not retry the sync: the URL is already
listed, so it exits 0 with `no new URLs to add` before reaching SSH.
