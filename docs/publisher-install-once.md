# One installation for the approved v0.14 publisher

This helper installs only the publisher connection for the approved main commit
`754a6a522e17538c5b9769afd112844dc7ed02c7`. It does not build, upload or activate
the game. The installer lives on a separately pinned support commit, so installing
it does not change which game commit the manual release workflow will build.

Use the reviewed command containing that support commit, the exact bootstrap
byte count and SHA-256. It retrieves fixed public GitHub resources over validated
TLS, refuses redirects, and verifies every byte before loading the installer.
There are no URL, repository, target-directory, key or shell parameters. Sources
remain in memory. `preflight` performs no installation writes. `apply` repeats the
preflight before any change; never repeat an apply with an unknown result.

The approved starting state is the existing phase-one receiver, its shared state
database at 0660, running account API, unchanged manually staged v0.14 candidate
and `current` selecting v0.13. The exact game Nginx baseline is
`b2c7dc4c44a7e035be4762afa30000973e23f933769dd7b3673a9055a54fadf9`.
Different files, metadata, units, drop-ins, pending work or acceptance markers stop
the operation. This is not a clean installation or a repair mode.

The application backs up only the known old publisher programs, three units and
game-site configuration under root-private
`/var/backups/fkssj-publisher-install`. Its exclusive attempt and journal prevent
replaying a partial installation. It installs the fixed program dependencies and
root-owned disabled policy, verifies unit syntax, reloads systemd, adds only the
exact upload and activate Nginx locations and tests the candidate configuration.
The new game configuration must be SHA-256
`fb16acbd3164418ede79b01f2a4e01e195b118d6f82daea2f5b4e663f1c5d80a`.
It reloads Nginx, restarts and enables the existing receiver, verifies unsigned
requests are rejected, then enables the reviewed policy and publisher timer.
The publisher runs as root under the previously approved unit restrictions.

The receiver's existing key, configuration and ledger are retained. Key checks
use metadata only. Queue checks parse a bounded, locked in-memory SQLite snapshot
and select only schema and state counts. No player database is opened. The API,
old game, manually staged candidate and current link are verified and preserved;
the installer creates no test accounts and sends no signed publication request.

Only `installed_verified` is successful. Any other result stops this procedure.
In particular, `partial_or_uncertain_inspect_no_retry` means preserve the journal
and inspect the recorded step before deciding another action. A Nginx candidate
syntax failure restores only the exact installer-owned candidate. A reload or
restart whose outcome is unknown is not retried or assumed to have rolled back.
There is no blanket restore, database rollback or account-budget reset.

After successful installation, separately verify the effective services, routes
and fixed configuration digests from the returned receipt. The earlier bounded
disk logging audit plus the operator's unchanged-loaded-configuration statement
remain prerequisites before a signed request. Unsigned 401 responses are not a
new audit of every Nginx include or an attestation of running configuration memory.
Only then set the existing GitHub readiness variables and run the authorized
manual release once, using the approved main commit above and explicit activation
mode. No push-triggered publication is installed here. The three real browser
checks remain `waived_not_run`, and the global two-account acceptance allowance
must never be reset. A confirmed game activation has its separate release-bound
static rollback described in `github-release-setup.md`; the API and databases are
never rolled back with it.
