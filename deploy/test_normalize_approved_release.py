"""Manifest reproduction fixtures only; never builds or deploys game output."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest import mock

from deploy import normalize_approved_release as subject


class NormalizeApprovedReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.base=Path(self.tmp.name);self.source=self.base/'static';self.source.mkdir(mode=0o755)
        self.release=subject.release_module()
        rows=[]
        for name in sorted(self.release.FILES):
            p=self.source/name;p.parent.mkdir(parents=True,exist_ok=True)
            raw=('PUBLIC INERT FIXTURE '+name).encode();p.write_bytes(raw);p.chmod(0o644)
            rows.append({'path':name,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
        for p in self.source.rglob('*'):
            if p.is_dir():p.chmod(0o755)
        self.approved={'version':'0.14.0','createdAt':'2026-10-26T00:00:00Z','fileCount':34,
                       'totalBytes':sum(v['bytes'] for v in rows),'files':rows}
        self.raw=(json.dumps(self.approved,indent=2)+'\n').encode()
        current={**self.approved,'createdAt':'2026-10-27T00:00:00Z'}
        self.current=(json.dumps(current,indent=2)+'\n').encode()
        (self.source/'release.json').write_bytes(self.current);(self.source/'release.json').chmod(0o644)
        self.patch_load=mock.patch.object(subject,'load_approved',return_value=self.raw)
        self.patch_sha=mock.patch.object(subject,'APPROVED_SHA',subject.digest(self.raw))
        self.patch_load.start();self.patch_sha.start();self.addCleanup(self.patch_load.stop);self.addCleanup(self.patch_sha.stop)

    def snap(self):
        return {str(p.relative_to(self.source)):(p.lstat().st_mode,p.read_bytes() if p.is_file() and not p.is_symlink() else None)
                for p in self.source.rglob('*')}

    def reject_unchanged(self):
        before=self.snap()
        with self.assertRaises(Exception):subject.normalize(self.source)
        self.assertEqual(before,self.snap())
        self.assertEqual((self.source/'release.json').read_bytes(),self.current)

    def test_timestamp_only_change_reproduces_exact_approved_manifest_then_idempotent(self):
        before={n:(self.source/n).read_bytes() for n in self.release.FILES}
        result=subject.normalize(self.source)
        self.assertEqual(result,{'state':'approved_static_reproduced','changed':True,
            'manifestSha256':subject.digest(self.raw),'fileCount':34})
        self.assertEqual((self.source/'release.json').read_bytes(),self.raw)
        self.assertEqual(before,{n:(self.source/n).read_bytes() for n in self.release.FILES})
        self.assertFalse(subject.normalize(self.source)['changed'])

    def test_real_approved_metadata_and_allowlist_are_exact(self):
        raw=Path(subject.__file__).with_name('approved-v014-release.json').read_bytes()
        self.assertEqual(hashlib.sha256(raw).hexdigest(),'b20e11a258007f39129a47601be7a291391c9275ad5ea6b51ab0e9e7f21aa272')
        data=self.release.strict_json(raw)
        self.assertEqual({v['path'] for v in data['files']},self.release.FILES)
        self.assertEqual(data['fileCount'],34)

    def test_payload_or_current_manifest_mismatch_has_zero_writes(self):
        (self.source/'index.html').write_bytes(b'UNAPPROVED FIXTURE')
        self.reject_unchanged()
        (self.source/'index.html').write_bytes(b'PUBLIC INERT FIXTURE index.html')
        current=json.loads(self.current);current['files'][0]['bytes']+=1
        self.current=(json.dumps(current,indent=2)+'\n').encode();(self.source/'release.json').write_bytes(self.current)
        self.reject_unchanged()

    def test_extra_missing_and_duplicate_manifest_path_rejected(self):
        extra=self.source/'unknown-secret.key';extra.write_bytes(b'FIXTURE_NEVER_READ')
        self.reject_unchanged();extra.unlink()
        saved=(self.source/'index.html').read_bytes();(self.source/'index.html').unlink()
        self.reject_unchanged();(self.source/'index.html').write_bytes(saved)
        current=json.loads(self.current);current['files'][-1]=current['files'][0]
        self.current=(json.dumps(current,indent=2)+'\n').encode();(self.source/'release.json').write_bytes(self.current)
        self.reject_unchanged()

    def test_file_symlink_hardlink_and_writable_directory_rejected(self):
        original=self.source/'index.html';raw=original.read_bytes();original.unlink()
        target=self.base/'elsewhere';target.write_bytes(raw);original.symlink_to(target)
        self.reject_unchanged();original.unlink();original.write_bytes(raw)
        os.link(original,self.base/'link');self.reject_unchanged();(self.base/'link').unlink()
        (self.source/'node_modules').chmod(0o775);self.reject_unchanged()

    def test_source_or_parent_symlink_and_existing_temp_are_rejected(self):
        outside=self.base/'detached';self.source.rename(outside);self.source.symlink_to(outside)
        with self.assertRaises(Exception):subject.normalize(self.source)
        self.assertEqual((outside/'release.json').read_bytes(),self.current)
        self.source.unlink();outside.rename(self.source)
        stale=self.source/'.approved-manifest-unknown';stale.write_bytes(b'owned by another attempt')
        self.reject_unchanged()

    def test_changed_payload_after_temp_creation_retains_original_manifest(self):
        real=subject.snapshot;calls=0
        def race(*args,**kwargs):
            nonlocal calls
            calls+=1
            if kwargs.get('temporary') is not None:
                (self.source/'index.html').write_bytes(b'UNAPPROVED RACING FIXTURE')
            return real(*args,**kwargs)
        with mock.patch.object(subject,'snapshot',side_effect=race),self.assertRaises(Exception):
            subject.normalize(self.source)
        self.assertEqual((self.source/'release.json').read_bytes(),self.current)
        self.assertFalse(any(p.name.startswith('.approved-manifest-') for p in self.source.iterdir()))

    def test_unknown_approved_file_digest_rejected_before_source_writes(self):
        self.patch_load.stop();self.patch_sha.stop()
        with mock.patch.object(subject,'APPROVED_SHA','0'*64):self.reject_unchanged()

    def test_replacement_unknown_is_not_reported_as_success(self):
        real=os.replace
        def replaced_then_failed(*args,**kwargs):
            real(*args,**kwargs);raise OSError('FIXTURE_ONLY_AFTER_REPLACE')
        with mock.patch.object(subject.os,'replace',side_effect=replaced_then_failed),self.assertRaises(Exception):
            subject.normalize(self.source)
        self.assertEqual((self.source/'release.json').read_bytes(),self.raw)
        self.assertFalse(any(p.name.startswith('.approved-manifest-') for p in self.source.iterdir()))


if __name__=='__main__':unittest.main()
