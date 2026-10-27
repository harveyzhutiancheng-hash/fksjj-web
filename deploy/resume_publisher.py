#!/usr/bin/env python3
"""Finish only the fixed receiver-enabled partial publisher installation.

The separately pinned bootstrap supplies the unchanged reviewed installer and
payload in memory. This entry never invokes its apply(), reinstalls programs,
reloads Nginx, restarts the receiver, dispatches a release or opens player data.
"""
import stat
import time

SOURCE = '754a6a522e17538c5b9769afd112844dc7ed02c7'
BINDINGS = '214904cf206c86587a0dfaf338dbf48ee8756183e0d968dcc818487d4987e1ab'
STEPS = (
    'attempt_saved', 'backup_saved', 'disabled_policy_saved',
    'programs_units_installed', 'daemon_reload_acknowledged',
    'nginx_candidate_saved', 'nginx_reload_acknowledged',
    'receiver_restart_acknowledged', 'receiver_enabled',
)


class Resume:
    def __init__(self, core, host, payload, bindings):
        self.c = core
        self.h = host
        self.e = core.Engine(host, payload, bindings)
        core.need(self.e.digest == BINDINGS and bindings['sourceCommit'] == SOURCE, 'bindings')
        self.attempt = core.BACKUP + '/resume-runtime-attempt.json'
        self.journal = core.BACKUP + '/resume-runtime-journal.jsonl'
        self.steps = []
        self.attempted = False
        self.policy_may_have_changed = False
        self.services_may_have_changed = False

    def _private(self, path):
        with self.h.directory(path) as fd:
            info = self.h.info(fd)
            self.c.need((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (0, 0, 0o700), 'metadata')

    def _runtime_ready(self):
        # Type=simple can acknowledge a restart before Python binds the socket.
        # Every attempt uses the unchanged strict checks; no condition is waived.
        for number in range(5):
            try:
                return self.e._fixed(True)
            except self.c.Failure as error:
                if error.code != 'runtime' or number == 4:
                    raise
                time.sleep(1)

    def _files(self):
        c, h = self.c, self.h
        expected = {'.phase1', *c.PROGRAMS}
        c.need(h.listing(c.PREFIX.rstrip('/')) == expected, 'existing')
        c.need(not h.exists(c.SYSTEM + 'fkssj-stage-publisher.service')
               and not h.exists(c.PREFIX + 'stage_publisher.py'), 'existing')
        for unit in c.UNITS:
            for prefix in ('/etc/systemd/system/', '/run/systemd/system/', '/usr/lib/systemd/system/'):
                c.need(not h.exists(prefix + unit + '.d'), 'unit')
        marks = {}
        for name in c.PROGRAMS:
            path = c.PREFIX + name
            raw, mark = h.read(path)
            c.need(raw == self.e.p[name], 'changed')
            marks[path] = mark
        for name in c.UNITS:
            path = c.SYSTEM + name
            raw, mark = h.read(path)
            c.need(raw == self.e.p[name], 'changed')
            marks[path] = mark
        raw, marks[c.NGINX] = h.read(c.NGINX)
        c.need(raw == self.candidate, 'nginx')
        return marks

    def _audit(self, resumed=False):
        c, h = self.c, self.h
        for path in (c.BACKUP, c.AUDIT, c.AUDIT + '/releases'):
            self._private(path)
        expected = {'install-attempt.json', 'journal.jsonl', 'original-nginx',
                    *('original-' + str(i) for i in range(len(c.OLD_FILES)))}
        if resumed:
            expected |= {'resume-runtime-attempt.json', 'resume-runtime-journal.jsonl'}
        c.need(h.listing(c.BACKUP) == expected and h.listing(c.AUDIT) == {'releases'}
               and h.listing(c.AUDIT + '/releases') == set(), 'attempt')
        attempt = c.encode({'schema': 1, 'bindingsSha256': BINDINGS,
                            'sourceCommit': SOURCE, 'state': 'attempted'})
        journal = b''.join(c.encode({'step': value}) for value in STEPS)
        marks = {}
        for path, expected_raw in ((c.ATTEMPT, attempt), (c.BACKUP + '/journal.jsonl', journal)):
            raw, mark = h.read(path, mode=0o600)
            c.need(raw == expected_raw, 'attempt')
            marks[path] = mark
        for index, (path, (size, digest)) in enumerate(c.OLD_FILES.items()):
            backup = c.BACKUP + '/original-' + str(index)
            raw, mark = h.read(backup, mode=0o600)
            c.need(len(raw) == size and c.sha(raw) == digest, 'changed')
            marks[backup] = mark
        raw, mark = h.read(c.BACKUP + '/original-nginx', mode=0o600)
        self.candidate = self.e._candidate(raw)
        marks[c.BACKUP + '/original-nginx'] = mark
        return marks

    def _verify(self, resumed=False):
        c, h = self.c, self.h
        c.need(h.euid() == 0, 'root')
        if not resumed:
            c.need(not h.exists(self.attempt) and not h.exists(self.journal), 'attempt')
        audit = self._audit(resumed)
        files = self._files()
        raw, policy_mark = h.read(c.CONFIG + 'publisher.json', mode=0o600)
        c.need(raw == c.encode(self.e.policy), 'existing')
        fixed = self._runtime_ready()
        for route in ('status', 'upload', 'activate'):
            h.http('/_fkssj-release/v1/' + route, 401)
        return {'audit': audit, 'files': files, 'policy': policy_mark, 'fixed': fixed}

    def preflight(self):
        with self.h.static_lock():
            self.snapshot = self._verify()
        return {'state': 'resume_preflight_ready', 'sourceCommit': SOURCE,
                'bindingsSha256': BINDINGS, 'originalSteps': len(STEPS),
                'mutations': False, 'accountsCreated': 0}

    def record(self, step):
        self.steps.append(step)
        self.h.journal(self.journal, step)

    def apply(self):
        c, h = self.c, self.h
        result = {'state': 'resume_stopped_no_changes', 'steps': self.steps,
                  'accountsCreated': 0, 'currentChangedByResume': False,
                  'servicesMayHaveChanged': False, 'policyMayHaveChanged': False}
        try:
            self.preflight()
            with h.static_lock():
                c.need(self._verify() == self.snapshot, 'changed')
                # Own, exclusive continuation records; original audit is immutable.
                self.attempted = True
                h.write(self.attempt, c.encode({'schema': 1, 'sourceCommit': SOURCE,
                    'bindingsSha256': BINDINGS, 'originalJournalSha256': c.sha(
                        b''.join(c.encode({'step': value}) for value in STEPS)),
                    'state': 'attempted'}), 0o600)
                h.write(self.journal, b'', 0o600)
                self.record('resume_attempt_saved')
                with h.worker_guard():
                    c.need(self._verify(True) == self.snapshot, 'changed')
                    h.queue()
                    raw, mark = h.read(c.CONFIG + 'publisher.json', mode=0o600)
                    c.need(raw == c.encode(self.e.policy) and mark == self.snapshot['policy'], 'changed')
                    self.policy_may_have_changed = True
                    enabled = c.encode(dict(self.e.policy, enabled=True))
                    enabled_mark = h.write(c.CONFIG + 'publisher.json', enabled, 0o600, replace=mark)
                    self.record('policy_enabled')
                    h.queue()
                    self.services_may_have_changed = True
                    h.command(['/usr/bin/systemctl', 'enable', '--now', 'fkssj-publisher.timer'], True)
                    self.record('timer_enable_start_acknowledged')
                    timer = h.unit('fkssj-publisher.timer')
                    c.need(timer['Id'] == 'fkssj-publisher.timer' and timer['LoadState'] == 'loaded'
                           and timer['ActiveState'] == 'active' and timer['UnitFileState'] == 'enabled'
                           and timer['DropInPaths'] == '' and timer['NeedDaemonReload'] == 'no'
                           and timer['FragmentPath'] == c.SYSTEM + 'fkssj-publisher.timer', 'runtime')
                    c.need(self._audit(True) == self.snapshot['audit']
                           and self._files() == self.snapshot['files'], 'changed')
                    c.need(h.read(c.CONFIG + 'publisher.json', mode=0o600) == (enabled, enabled_mark), 'changed')
                    c.need(h.link('current', c.OLD) == self.e.current and not h.exists(c.BUDGET)
                           and not h.exists('/opt/fkssj-api/preview.closed')
                           and not h.exists('/srv/fkssj/.static-release-pending.json'), 'changed')
                    h.queue()
                    h.http('/api/health', 200)
                    self.record('resume_verified_no_release_dispatched')
                return dict(result, state='installed_verified', sourceCommit=SOURCE,
                            bindingsSha256=BINDINGS, timerEnabled=True,
                            policyMayHaveChanged=True, servicesMayHaveChanged=True)
        except BaseException as error:
            return dict(result, state='resume_partial_or_uncertain_inspect_no_retry' if self.attempted else 'resume_stopped_no_changes',
                        reason=error.code if isinstance(error, c.Failure) else 'unexpected',
                        uncertain=isinstance(error, c.Uncertain),
                        servicesMayHaveChanged=self.services_may_have_changed,
                        policyMayHaveChanged=self.policy_may_have_changed)
