"""Only the game /api/ proxy; reuse the reviewed owned-file nginx transaction."""
import hashlib

OLD_SHA = '779c662a0d5e97b55c8b15718a1eb13cabbb810edde554a3a5e7d23315e107a0'
BACKUP = '/var/backups/fkssj-api-nginx-20261026'
LOCATION = b'''    location ^~ /api/ {
        client_max_body_size 1m;
        client_body_timeout 15s;
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_request_buffering on;
        proxy_buffering off;
        proxy_cache off;
        proxy_intercept_errors off;
        proxy_next_upstream off;
        proxy_connect_timeout 3s;
        proxy_send_timeout 35s;
        proxy_read_timeout 35s;
        proxy_hide_header Cache-Control;
        proxy_hide_header X-Content-Type-Options;
        proxy_hide_header Referrer-Policy;
        add_header Cache-Control "no-store" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "same-origin" always;
    }
'''


def candidate(base):
    if hashlib.sha256(base).hexdigest() != OLD_SHA:
        raise ValueError('fixed_baseline_required')
    anchor = b'    location = /_fkssj-release/v1/status {'
    if base.count(anchor) != 1:
        raise ValueError('fixed_baseline_required')
    return base.replace(anchor, LOCATION+anchor, 1)


def safe(report, sha):
    return (report.get('status') == 'safe' and report.get('reasons') == []
            and report.get('targetSha256') == sha and report.get('summaries')
            and all(s.get('diskAuditComplete') and s.get('snapshotStable')
                    and s.get('isolationVerified') and s.get('structureVerified')
                    and s.get('loggingAnalysisComplete') and s.get('defaultPhaseLogsChecked')
                    for s in report['summaries']))


class Engine:
    def __init__(self, legacy_module, routing_module, host=None, audit=None):
        self.nginx, self.routing = legacy_module, routing_module
        self.host = host or legacy_module.Host()
        self.audit = audit or self.disk_audit
        baseline = legacy_module.CANDIDATE
        if hasattr(legacy_module, '_API_ORIGINAL_STATUS'):
            baseline = legacy_module._API_ORIGINAL_STATUS
        else:
            legacy_module._API_ORIGINAL_STATUS = baseline
        self.baseline, self.candidate = baseline, candidate(baseline)
        self.sha = hashlib.sha256(self.candidate).hexdigest()
        legacy_module.BASELINE, legacy_module.BASELINE_SHA = baseline, OLD_SHA
        legacy_module.CANDIDATE, legacy_module.CANDIDATE_SHA = self.candidate, self.sha
        legacy_module.BACKUP, legacy_module.PENDING = BACKUP, '.fkssj-api-nginx.pending'
        legacy_module.ENDPOINT = 'https://fkssj.harvey-ai.xyz/api/health'

    def disk_audit(self, sha):
        core = self.routing._modules()
        base = core[-1]
        original = base.TARGET_SHA256
        try:
            base.TARGET_SHA256 = sha
            return self.routing.audit(_core=core)
        finally:
            base.TARGET_SHA256 = original

    def adapter(self):
        engine = self
        class Adapter(self.nginx.Host):
            def __init__(self):pass
            def euid(self):return engine.host.euid()
            def meta(self, fd):return engine.host.meta(fd)
            def owner(self, fd, uid, gid):return engine.host.owner(fd,uid,gid)
            def directory(self, path):return engine.host.directory(path)
            def command(self, name):
                if name == 'test':
                    raw, ignored = engine.nginx.current(self)
                    sha = hashlib.sha256(raw).hexdigest()
                    if sha not in (OLD_SHA,engine.sha) or not safe(engine.audit(sha),sha):
                        return {'state':'not_started','returncode':None}
                return engine.host.command(name)
        return Adapter()

    def plan(self):
        if not safe(self.audit(OLD_SHA),OLD_SHA):
            return {'state':'stopped_no_changes','reason':'nginx_disk_log_audit_not_safe'}
        result=self.nginx.preflight(self.adapter())
        result.pop('diff',None)
        return result

    def apply(self):
        result=self.plan()
        if result.get('state') != 'preflight_ok_await_authorization':
            return result
        # No new global/include/log settings. API and preview inherit the exact
        # status route's audited server/global logs; LOCATION has no log override.
        return self.nginx.apply(self.adapter(),self.sha)
