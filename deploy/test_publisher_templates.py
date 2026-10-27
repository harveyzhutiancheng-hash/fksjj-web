"""Template contract only: no install, service start, nginx invocation or key read."""
import hashlib
import json
from pathlib import Path
import re
import unittest

HERE=Path(__file__).with_name('templates')


def unit():
    result={}
    for line in (HERE/'fkssj-publisher.service').read_text().splitlines():
        if line and not line.startswith(('#','[')):
            key,sep,value=line.partition('=')
            if sep:result.setdefault(key,[]).append(value)
    return result


class PublisherTemplateTests(unittest.TestCase):
    def test_dormant_policy_is_exactly_scoped_and_contains_no_credentials(self):
        value=json.loads((HERE/'publisher-config.example.json').read_text())
        self.assertEqual(set(value),{'schema','enabled','maximumAutomaticAccounts','approvedManifestSha256','apiBindings'})
        self.assertIs(value['enabled'],False)
        self.assertIs(type(value['maximumAutomaticAccounts']),int)
        self.assertEqual(value['maximumAutomaticAccounts'],2)
        self.assertEqual(value['apiBindings']['manifestSha256'],value['approvedManifestSha256'])
        for key,data in value['apiBindings'].items():
            if key!='backendTarget':self.assertRegex(data,r'^[0-9a-f]{64}$')
        self.assertEqual(value['apiBindings']['backendTarget'],'api-releases/fkssj-api-2aa9c0eb6dc0c3a6')
        self.assertNotRegex(json.dumps(value),r'(?i)token|password|hmac|private.key')

    def test_disabled_policy_pins_the_exact_post_route_candidate(self):
        from deploy import manual_api_nginx,nginx_status_only
        baseline=manual_api_nginx.candidate(nginx_status_only.CANDIDATE)
        self.assertEqual(hashlib.sha256(baseline).hexdigest(),
            'b2c7dc4c44a7e035be4762afa30000973e23f933769dd7b3673a9055a54fadf9')
        active='\n'.join(line for line in (HERE/'nginx-release.conf').read_text().splitlines()
                           if not line.lstrip().startswith('#')).strip()+'\n'
        addition=''.join('    '+line+'\n' if line else '\n' for line in active.splitlines()).encode()
        anchor=b'    location = /_fkssj-release/v1/status {'
        self.assertEqual(baseline.count(anchor),1)
        candidate=baseline.replace(anchor,addition+anchor,1)
        policy=json.loads((HERE/'publisher-config.example.json').read_text())
        self.assertEqual(policy['apiBindings']['nginxConfigSha256'],hashlib.sha256(candidate).hexdigest())
        self.assertEqual(len(candidate),4929)

    def test_privileged_fixed_worker_has_explicit_bounded_namespace(self):
        u=unit()
        self.assertEqual(u['User'],['root'])
        self.assertEqual(u['Group'],['fkssj-release'])
        self.assertEqual(u['ExecStart'],['/usr/bin/python3 -I -B /opt/fkssj-release/release_channel.py publish-worker'])
        self.assertEqual(u['Restart'],['no'])
        self.assertEqual(u['CapabilityBoundingSet'],['CAP_DAC_OVERRIDE'])
        self.assertEqual(u['AmbientCapabilities'],[''])
        self.assertEqual(u['NoNewPrivileges'],['true'])
        self.assertEqual(u['UMask'],['0007'])
        self.assertEqual(u['PrivateNetwork'],['false'])
        self.assertEqual(u['RestrictAddressFamilies'],['AF_UNIX AF_INET AF_INET6'])
        self.assertEqual(u['ProtectSystem'],['strict'])
        self.assertEqual(u['ProtectHome'],['true'])
        self.assertEqual(u['InaccessiblePaths'],['-/var/lib/fkssj'])
        self.assertNotIn('WantedBy',u)
        writable=set(' '.join(u['ReadWritePaths']).split())
        self.assertEqual(writable,{'/var/lib/fkssj-release','/srv/fkssj','/var/backups/fkssj-publisher','/var/backups/fkssj-api','/opt/fkssj-api'})
        readonly=set(' '.join(u['ReadOnlyPaths']).split())
        self.assertTrue({'/opt/fkssj-release','/etc/fkssj-release','/srv/fkssj/api-releases',
                         '/opt/fkssj-api/venv','/opt/fkssj-api/wheels','/opt/fkssj-api/manual-static',
                         '/opt/fkssj-api/requirements.txt'}<=readonly)
        self.assertNotIn('/var/lib/fkssj',writable)

    def test_only_two_new_exact_routes_and_no_authentication_log_directives(self):
        text=(HERE/'nginx-release.conf').read_text()
        active='\n'.join(line for line in text.splitlines() if not line.lstrip().startswith('#'))
        self.assertEqual(re.findall(r'^location = (\S+) \{',active,re.M),
                         ['/_fkssj-release/v1/upload','/_fkssj-release/v1/activate'])
        self.assertNotRegex(active,r'(?m)^\s*(?:listen|server_name|ssl_|include|access_log|error_log|log_format)\b')
        self.assertNotIn('/v1/status',active)
        for operation,limit in [('upload','16m'),('activate','1k')]:
            body=active.split('location = /_fkssj-release/v1/'+operation+' {',1)[1].split('\nlocation = ',1)[0]
            self.assertIn('proxy_pass http://127.0.0.1:8790/v1/'+operation+';',body)
            self.assertIn('client_max_body_size '+limit+';',body)
            self.assertIn('limit_except POST { deny all; }',body)
            self.assertIn('proxy_next_upstream off;',body)
            self.assertIn('proxy_intercept_errors off;',body)
            for header in ('Cache-Control','X-Content-Type-Options','Referrer-Policy'):
                self.assertEqual(body.count('proxy_hide_header '+header+';'),1)
                self.assertEqual(body.count('add_header '+header+' '),1)
        self.assertEqual(active.count('add_header Cache-Control "no-store" always;'),2)

    def test_cold_stage_candidate_keeps_its_original_lower_privilege_boundary(self):
        stage=(HERE/'fkssj-stage-publisher.service').read_text()
        self.assertIn('User=fkssj-deploy',stage)
        self.assertIn('PrivateNetwork=true',stage)
        self.assertIn('RestrictAddressFamilies=AF_UNIX',stage)
        self.assertIn('release_channel_stage.py stage-worker',stage)
        self.assertNotIn('publish-worker',stage)
        self.assertNotIn('CapabilityBoundingSet=CAP_DAC_OVERRIDE',stage)


if __name__=='__main__':unittest.main()
