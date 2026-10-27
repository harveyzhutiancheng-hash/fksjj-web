# GitHub Actions → existing signed HTTPS publisher

This is the proposed first installation of the publishing connection. The code,
workflow and unit files do not demonstrate that the server is configured or that
a release has run. The workflow is manual `workflow_dispatch` only; a push or pull
request does not publish. Existing receiver and API services, keys, player data,
old releases and the manually staged candidate must be retained.

The path is: fixed approved commit → tests → reproduce the approved static
manifest → signed upload → authenticated `staged` → explicitly selected
activation → server API acceptance → candidate-scoped QA decision → fresh API
receipt → atomic switch → authenticated result and public manifest verification.
An upload HTTP 202 proves receipt only. A green source test or an inactive
configuration template does not prove server publication.

## What this release permits

The initial policy approves only static manifest
`b20e11a258007f39129a47601be7a291391c9275ad5ea6b51ab0e9e7f21aa272`.
`deploy/approved-v014-release.json` preserves that manifest's original bytes.
The normalization step first compares all 34 payload files, sizes and digests;
it refuses a changed payload rather than relabeling it as the old candidate.
It then restores the approved manifest bytes, including its original timestamp.
The signed channel uses a new 32-hex release identifier and a separate journal;
the existing manually staged directory is neither renamed nor adopted as a
channel release.

The explicit decision for this candidate records `basic_ui`, `two_tabs` and
`independent_context` as `waived_not_run`. It is not a browser pass. The five
checks previously executed in Node remain classified as fault injections.
Real browser rendering, mobile layout, shared local-cache/tab behavior, actual
offline and quota failures, and independent-account restore remain unverified.
The waiver is specific to this candidate and does not waive another version or
any future push. API acceptance, file integrity and atomic-switch checks cannot
be waived by this setting.

Only two automatic synthetic accounts are authorized for this release. The
publisher creates the global exclusive marker
`/var/backups/fkssj-api/acceptance-attempt.json` before any possible registration,
as well as the release-specific audit record. An existing marker blocks another
attempt, including a new release identifier. Do not remove, truncate, replace or
reset it. Future account reuse or a new acceptance allowance requires a separate
explicit decision; changing the release ID is not a new allowance.

## One bounded installation approval is still required

An administrator must review the exact merged commit and file digests, then
approve the following changes together. Existing Workbench administration is
sufficient; no new SSH key, PAT, HMAC key, sudo grant, user or group is required.
This guide does not perform those changes and is not an installation script.
The first bootstrap may retrieve only reviewed public repository files from one
fixed full commit, verify their hashes locally, then install them. It must not
execute downloaded shell or uploaded package scripts. Normal server HTTPS access
to those fixed GitHub resources has to be verified; it is not assumed here.

| Target | Proposed owner/mode and purpose |
| --- | --- |
| `/opt/fkssj-release/` | root-owned 0755; reviewed Python code 0644; receiver cannot write it and the publisher namespace mounts it read-only |
| `release_channel.py`, `static-release.py`, `publisher_pipeline.py`, `manual_api_acceptance.py`, `manual_static_switch.py`, `receipt-v0.13.0-2026-10-20.json` in that directory | Fixed installed publisher dependencies; no code comes from an uploaded static archive |
| `/etc/fkssj-release/publisher.json` | root-owned 0600 (or root-owned 0640), no group/other write; copy the example with `enabled:false` until all prerequisites pass |
| `/var/backups/fkssj-publisher/releases/` | root-owned 0700; each 32-hex release gets its own root-private records, receipt, switch result and rollback evidence |
| `/var/backups/fkssj-publisher-install/<reviewed-install-id>/` | Separate root-private 0700 backup of changed code, policy, unit and game-site configuration; outside active Nginx include paths and runtime publisher writes |
| `/etc/systemd/system/fkssj-publisher.service` | root-owned 0644; fixed `publish-worker` entry point; no arguments from the HTTP request |
| Existing `/etc/systemd/system/fkssj-publisher.timer` | Keep stopped/disabled during installation; enabling its existing bounded schedule requires explicit approval |
| `/etc/nginx/conf.d/fkssj-domain.conf` | Preserve existing site; add only the two exact locations from `deploy/templates/nginx-release.conf` |

The existing `/etc/fkssj-release/hmac.key`, receiver `config.json`, shared state
and account API installation are not recreated. No key content, environment
secret, Cookie, account password, database row or unrelated site configuration
is needed in the installation report.

### New publisher authority

The old cold-stage-only candidate remains separately available as
`fkssj-stage-publisher.service`. It cannot activate and is not the service used
by this workflow. It must not be started or enabled as a shortcut.

The new `fkssj-publisher.service` runs one fixed job as
`root:fkssj-release`. This is new persistent execution authority and must not be
hidden as a routine unit reload. It needs:

- `CAP_DAC_OVERRIDE` to atomically replace `current` beneath the existing
  1001-owned 0755 static root. No `CAP_CHOWN`, setuid capability or general
  deploy-account sudo is proposed.
- Verified HTTPS API access and one fixed `fkssj-api.service` restart through
  systemd, so `PrivateNetwork=false` and AF_UNIX/AF_INET/AF_INET6 are explicit.
  The one-unit restart restriction is enforced by the fixed code, not by an OS
  or D-Bus permission whitelist: this root process has broader manager authority
  if its installed code is compromised. This must be included in the approval.
  Address-family controls are not a domain firewall; the Python transport fixes
  the HTTPS origin/routes, validates TLS and rejects redirects/arbitrary URLs.
- Writes to the existing shared queue, static root, new publisher audit root and
  existing API backup directory for the global account-budget marker.
- Write access to `/opt/fkssj-api` only to create `preview.closed` exclusively
  after a confirmed switch. Its existing `venv`, `wheels`, `manual-static` and
  `requirements.txt` children stay read-only. The file must not be pre-created,
  as that would close the preview before activation.

The player directory `/var/lib/fkssj` is inaccessible in this service's filesystem
namespace. Acceptance uses synthetic accounts over HTTPS; it does not open the
player database. The receiver keeps its existing low-privilege identity and
loopback listener. No new public port or listener is proposed.

## Preflight and safe application

Combine these checks with the actual installation transaction instead of asking
an operator to run repeated diagnostic uploads:

1. Confirm the receiver/API identities, installed code and effective units,
   fixed listeners, current link, static lock ownership/mode, shared-state
   metadata and non-sensitive queue-state counts. Check both global and
   release-specific attempts. Any pending, processing, uncertain or unfamiliar
   state stops installation. Do not read key contents, player rows or secret
   logs. The old cold-stage installer assumed no API and a different Nginx
   baseline; it must not be rerun.
2. Verify the current game configuration is a root-owned regular file with one
   hard link and exact SHA-256
   `b2c7dc4c44a7e035be4762afa30000973e23f933769dd7b3673a9055a54fadf9`.
   Validate its actual route and logging structure without dumping all Nginx
   configuration. Further drift or uncertain logging stops this transaction.
3. Back up only the known files outside `conf.d`; verify reviewed source hashes,
   ownership, no symlink path components and exclusive targets before writing.
   Install code atomically, keep the policy disabled and preserve the receiver
   state database and global budget marker. Never recursively chown/chmod the
   existing static root.
4. Insert the snippet's active lines, indented four spaces, immediately before
   the single existing exact status location. This deterministic candidate is
   4929 bytes, SHA-256
   `fb16acbd3164418ede79b01f2a4e01e195b118d6f82daea2f5b4e663f1c5d80a`.
   It retains the status location, `/api/`, security headers, HTTP renewal and
   redirect behavior and all other sites. A different baseline does not permit
   blindly replacing the file. The policy must pin this **new** Nginx hash;
   retaining the old hash would correctly fail API acceptance.
5. Run standard unit syntax checks and `nginx -t` locally before a reload. A
   candidate-test failure leaves the original active. If a candidate was swapped
   but reload failed, restore only an exact owned candidate from the validated
   backup and retest/reload; changed ownership, a changed target or an unknown
   reload result requires inspection. Do not replay a mutation on a lost result.
   Externally report only fixed result codes and non-sensitive digests, not raw
   configuration, authentication values or unrelated logs.
6. After approval, reload the game Nginx configuration. If installed receiver
   code changed, perform the separately reviewed receiver restart to load that
   exact version; keep its identity, existing key and 127.0.0.1:8790 binding.
   Confirm the API is still healthy and `current` still points to the old game.
   Unsigned POSTs on upload/activate must be rejected by authentication; methods
   outside POST remain rejected. A 404 means that route is not ready.
7. Only after the code/policy/unit checks pass may an administrator enable the
   candidate policy and approve starting the fixed publisher schedule. The
   queue worker processes at most one job per invocation. Its timer is needed
   to remove the per-release manual worker-start step, but it is not enabled by
   this repository or this guide. The original signed-envelope window is at most
   300 seconds; scheduling cannot renew it or automatically retry a mutation.

These are real server operations still awaiting approval and execution. A local
unit/contract test does not prove the corresponding systemd namespace, Nginx
reload, receiver restart or real server network capability.

## GitHub setup and first release

Use the existing protected `fkssj-release-receive` environment and its existing
`FKSSJ_RELEASE_HMAC_KEY_HEX` Secret; do not expose or copy its value into source,
logs, artifacts or another credential. Retain its required reviewer and main-only
deployment rule. A YAML environment name by itself does not configure protection.

Keep `FKSSJ_RELEASE_CHANNEL_READY` and `FKSSJ_RELEASE_ACTIVATION_READY` unset
until the matching real server checks have completed. Only then set the reviewed
readiness values. They are local workflow gates, not replacements for server
policy, API acceptance or a signed result.

After the draft PR has been reviewed and a separate merge decision made, choose
that exact main commit in the manual workflow. Inputs are its full commit SHA,
the independently checked `releases/<id>` current target, and `mode`:

- `stage` is the default: build/test/sign/upload/wait for `staged`; no account
  acceptance or static switch.
- `activate` is an explicit decision: the same run stages once, then sends one
  signed activation. The server performs the retained ten API checks, at most
  two synthetic accounts and the approved candidate's truthful QA decision,
  creates its fresh receipt and switches atomically. Workflow output must reach
  authenticated `activated` and match the public manifest/version. This is not
  a browser or device test.

Unknown upload/activation/status outcomes are failures, not permissions to
re-upload, issue another activation, clear state or automatically roll back.
Use the saved non-secret release bindings for a fresh authenticated status query
and inspect the precise current link/audit record before deciding another action.

This workflow publishes static game files. It does not install account API
updates, publisher code, system units or new policies. A new manifest, API code,
QA decision or account allowance is not silently approved by this first
candidate's configuration. Future release policy must be reviewed explicitly;
there is no automatic deployment on every push.

## Recovery boundaries

Before a switch, failure preserves the old `current` and all staged bytes.
After an uncertain switch, preserve processing/pending/audit records and inspect
before any further mutation. A failed API acceptance does not produce a usable
receipt and cannot activate.

The code exposes a fixed, release-bound static rollback operation. It is not
a public endpoint or an automatic workflow step. An administrator must review
its exact release binding before a one-off invocation; until that invocation is
prepared, preserve the state instead of substituting an old manual command.
Use it only after a confirmed activation. It verifies the actual current candidate, prior snapshot,
manifest and release audit before atomically restoring the prior static target.
Do not reuse the old manual candidate's rollback record for a new 32-hex channel
release. Neither static rollback nor a code/unit/config backup restoration may
restore, downgrade, delete or overwrite the account database, player saves,
receiver ledger, HMAC key or account-budget marker. Rollback does not reset the
two-account allowance or make an unknown publication safe to retry.

### Administrator static rollback

After confirming this release was activated, an existing administrator may use
`sudo -n /usr/bin/python3 -I -B /opt/fkssj-release/release_channel.py rollback-static <32-hex-release-id>`.
This has no public HTTP route, reads no HMAC key, creates no accounts and does
not enable a disabled publisher policy. It requires the saved root-private
activation record, exact current target and unchanged old/candidate snapshots.
Unknown or replaced pending markers are retained; failure never triggers a
second switch. The result must be `rolled_back_verified`. The API/database and
global account-budget marker stay intact. Queue status describes the historical
activation operation; use the rollback receipt and public version check to
confirm the subsequently selected static version.
