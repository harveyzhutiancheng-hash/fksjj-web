"""Offline structure checks for a candidate, not nginx -t or a real reload.

Only the two committed text fixtures are read. The conservative existing
parser operates through a memory-only reader; no server config, key or log is
opened. The candidate is not installed by these tests.
"""
import copy
import difflib
import hashlib
from pathlib import Path
import unittest

from deploy import nginx_log_audit as syntax
from deploy import nginx_status_only as baseline


PATH = Path(__file__).with_name('templates') / 'nginx-cold-stage.conf'
BASELINE_SHA = '779c662a0d5e97b55c8b15718a1eb13cabbb810edde554a3a5e7d23315e107a0'
CANDIDATE_SHA = 'c6807009dff411e8d6a9659c4b1b74ff41a859bd704991e10eb61a3e9ae2fc1f'
UPLOAD_PATH = '/_fkssj-release/v1/upload'
STATUS_PATH = '/_fkssj-release/v1/status'


class MemoryReader:
    def __init__(self, data):
        self.data = data
        self.calls = []

    def read(self, path):
        if path != baseline.TARGET:
            raise AssertionError('Only the fixed memory fixture may be parsed')
        self.calls.append(path)
        return self.data


def parse(data):
    reader = MemoryReader(data)
    nodes = syntax.Parser(reader).file(baseline.TARGET)
    if reader.calls != [baseline.TARGET]:
        raise AssertionError('Unexpected configuration reference')
    return nodes


def location(server, args):
    nodes = [n for n in server.children if n.name == 'location' and n.args == args]
    if len(nodes) != 1:
        raise AssertionError('Expected one fixed location')
    return nodes[0]


def directives(node, name):
    return [n for n in node.children if n.name == name]


def walk(nodes):
    for node in nodes:
        yield node
        if node.children:
            yield from walk(node.children)


class ColdStageNginxCandidateTests(unittest.TestCase):
    def setUp(self):
        self.data = PATH.read_bytes()
        self.before = parse(baseline.CANDIDATE)
        self.after = parse(self.data)
        self.assertEqual(len(self.before), 2)
        self.assertEqual(len(self.after), 2)
        self.https = self.after[1]
        self.upload = location(self.https, ['=', UPLOAD_PATH])

    def single(self, name, args):
        nodes = directives(self.upload, name)
        self.assertEqual(len(nodes), 1, name)
        self.assertIsNone(nodes[0].children)
        self.assertEqual(nodes[0].args, args)

    def test_reviewed_baseline_and_candidate_bytes_are_pinned(self):
        self.assertEqual(hashlib.sha256(baseline.CANDIDATE).hexdigest(), BASELINE_SHA)
        self.assertEqual(hashlib.sha256(self.data).hexdigest(), CANDIDATE_SHA)
        self.assertEqual(len(self.data), 3005)

    def test_only_one_contiguous_upload_block_is_inserted(self):
        old_lines = baseline.CANDIDATE.splitlines(keepends=True)
        new_lines = self.data.splitlines(keepends=True)
        changes = [op for op in difflib.SequenceMatcher(
            a=old_lines, b=new_lines, autojunk=False).get_opcodes() if op[0] != 'equal']
        self.assertEqual(len(changes), 1)
        operation, old_start, old_end, new_start, new_end = changes[0]
        self.assertEqual(operation, 'insert')
        self.assertEqual(old_start, old_end)
        inserted = b''.join(new_lines[new_start:new_end])
        self.assertTrue(inserted.startswith(b'    location = /_fkssj-release/v1/upload {\n'))
        self.assertTrue(inserted.endswith(b'    }\n'))
        self.assertEqual(self.data.replace(inserted, b'', 1), baseline.CANDIDATE)

    def test_status_location_bytes_and_all_other_structure_are_unchanged(self):
        self.assertEqual(self.data.count(baseline.LOCATION), 1)
        self.assertEqual(location(self.after[1], ['=', STATUS_PATH]),
                         location(self.before[1], ['=', STATUS_PATH]))
        candidate_without_upload = copy.deepcopy(self.after)
        candidate_without_upload[1].children = [
            n for n in candidate_without_upload[1].children
            if not (n.name == 'location' and n.args == ['=', UPLOAD_PATH])]
        self.assertEqual(candidate_without_upload, self.before)
        self.assertEqual(self.after[0], self.before[0])

    def test_exact_upload_is_post_only_and_nonexact_routes_remain_closed(self):
        guard = directives(self.upload, 'limit_except')
        self.assertEqual(len(guard), 1)
        self.assertEqual(guard[0].args, ['POST'])
        self.assertEqual(len(guard[0].children), 1)
        self.assertEqual(guard[0].children[0].name, 'deny')
        self.assertEqual(guard[0].children[0].args, ['all'])
        closed_prefix = location(self.https, ['^~', '/_fkssj-release/'])
        self.assertEqual([(n.name, n.args) for n in closed_prefix.children], [('return', ['404'])])
        closed_root = location(self.https, ['=', '/_fkssj-release'])
        self.assertEqual([(n.name, n.args) for n in closed_root.children], [('return', ['404'])])
        self.assertFalse(any(n.name == 'location' and
                             any('/activate' in arg for arg in n.args) for n in walk(self.after)))

    def test_fixed_loopback_proxy_and_exact_body_and_timeout_limits(self):
        for name, args in {
                'client_max_body_size': ['16m'], 'client_body_timeout': ['30s'],
                'proxy_pass': ['http://127.0.0.1:8790/v1/upload'],
                'proxy_http_version': ['1.1'], 'proxy_connect_timeout': ['3s'],
                'proxy_send_timeout': ['35s'], 'proxy_read_timeout': ['35s']}.items():
            self.single(name, args)
        targets = [n.args for n in walk(self.after) if n.name == 'proxy_pass']
        self.assertCountEqual(targets, [['http://127.0.0.1:8790/v1/upload'],
                                       ['http://127.0.0.1:8790/v1/status']])

    def test_no_proxy_retry_cache_or_error_interception_is_enabled(self):
        for name, args in {
                'proxy_request_buffering': ['on'], 'proxy_buffering': ['off'],
                'proxy_cache': ['off'], 'proxy_intercept_errors': ['off'],
                'proxy_next_upstream': ['off']}.items():
            self.single(name, args)
        self.assertEqual({n.name for n in self.upload.children}, {
            'limit_except', 'client_max_body_size', 'client_body_timeout',
            'proxy_pass', 'proxy_http_version', 'proxy_set_header',
            'proxy_request_buffering', 'proxy_buffering', 'proxy_cache',
            'proxy_intercept_errors', 'proxy_next_upstream',
            'proxy_connect_timeout', 'proxy_send_timeout', 'proxy_read_timeout',
            'proxy_hide_header', 'add_header'})

    def test_response_headers_are_explicit_at_location_scope(self):
        self.single('proxy_hide_header', ['Cache-Control'])
        self.assertCountEqual([n.args for n in directives(self.upload, 'add_header')], [
            ['Cache-Control', 'no-store', 'always'],
            ['X-Content-Type-Options', 'nosniff', 'always'],
            ['Referrer-Policy', 'same-origin', 'always']])
        # Declaring all three locally avoids nginx's add_header inheritance
        # replacing the two inherited security headers when setting no-store.
        self.assertEqual(len(directives(self.upload, 'add_header')), 3)

    def test_only_fixed_signature_forwarding_and_no_new_logging_or_references(self):
        headers = [n.args for n in directives(self.upload, 'proxy_set_header')]
        self.assertCountEqual(headers, [
            ['Connection'],
            ['X-FKSSJ-Envelope', '$http_x_fkssj_envelope'],
            ['X-FKSSJ-Signature', '$http_x_fkssj_signature']])
        self.assertIn(b'        proxy_set_header Connection "";\n', self.data)
        for node in walk([self.upload]):
            self.assertNotIn(node.name, {'access_log', 'error_log', 'log_format',
                                        'include', 'rewrite', 'return', 'root',
                                        'alias', 'proxy_redirect', 'auth_request'})
        # The unchanged conservative audit pins the status-only baseline. This
        # candidate needs its own reviewed pin before any later signed upload.
        self.assertEqual(syntax.TARGET_SHA256, BASELINE_SHA)
        self.assertNotEqual(CANDIDATE_SHA, syntax.TARGET_SHA256)


if __name__ == '__main__':
    unittest.main()
