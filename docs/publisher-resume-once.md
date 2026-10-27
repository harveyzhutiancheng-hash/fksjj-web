# Continue the receiver-enabled partial installation once

This entry applies only to the approved installation from helper commit
`f91f1b4f8005f94fac618170b67e9bfee99775dc`, using game/main commit
`754a6a522e17538c5b9769afd112844dc7ed02c7`. The first attempt stopped with
`runtime` after the nine journal steps ending at `receiver_enabled`. Its exact
original attempt, journal, six backups, installed files and unchanged static/API
bindings must still verify. A different or already completed state is refused.

The operator subsequently observed all original runtime conditions satisfied,
three unsigned release POSTs returning 401 with the required headers, disabled
publisher policy and timer, an empty release queue, no acceptance attempt and
v0.13 still selected. This does not establish which runtime assertion failed in
the original attempt. The receiver uses `Type=simple`, so readiness timing is a
possible explanation, not a proven root cause.

The new bootstrap fetches and verifies the original helper as a module, calls
only its fixed download bundle, and loads the unchanged original installer core
in memory. It never invokes the old bootstrap's run/main or installer apply.
The continuation verifies the exact partial state and performs the full original
runtime checks up to five times, one second apart, only when they return the
runtime code. Every condition remains required. Other errors stop immediately.

Only these remaining changes are made: create two exclusive root-private
continuation audit files in the existing install backup directory; acquire the
existing static and publisher locking boundaries; atomically change the fixed
publisher policy from disabled to enabled; enable and start the reviewed timer;
verify the final files, queue, current link, absence of account-budget and switch
markers, and API health. The worker lock may be created exclusively if absent,
using the original reviewed Host implementation. Original records are preserved.

No program or Nginx file is rewritten. No receiver or API restart, daemon reload,
game build/upload/activation, account creation, key rotation, player-data access
or database rollback is performed. Sources remain in memory. Preflight is read
only; apply repeats it before writing. The only successful final state is
`installed_verified`. Every other result must be inspected before another action;
do not rerun either the original installer or this continuation after an unknown
or partial result. A new release is still a separately authorized manual workflow
run after the real installation receipt is checked.
