"""Unknown pending markers survive a completed-switch failure; temporary files only."""
import os
import unittest
from unittest import mock
from deploy import test_static_release as fixtures


class PendingIdentityTests(unittest.TestCase):
    def fixture(self):
        fx=fixtures.StaticReleaseTests(methodName='runTest');fx.setUp()
        self.addCleanup(fx.doCleanups);fx.stage();fx.release_id='TEST-FIXTURE-v014'
        return fx

    def substituted_marker(self,same_content):
        fx=self.fixture();s=fixtures.release;real=s.write_new;foreign={}
        def write(fd,name,data):
            result=real(fd,name,data)
            if name.startswith('.static-release-completed-'):
                old=(fx.root/s.PENDING).read_bytes()
                # Rename retains the original inode, so even filesystems that
                # eagerly reuse unlinked inode numbers cannot mask this test.
                os.rename(fx.root/s.PENDING,fx.root/'fixture-original-pending')
                replacement=old if same_content else b'FOREIGN UNKNOWN MARKER\n'
                (fx.root/s.PENDING).write_bytes(replacement)
                foreign['bytes']=replacement;foreign['inode']=(fx.root/s.PENDING).stat().st_ino
            return result
        with mock.patch.object(s,'write_new',side_effect=write):
            with self.assertRaises(s.Uncertain):
                s.activate(fx.release_id,fx.manifest_hash,'releases/old',fx.receipt_path,fx.receipt_hash,
                           fx.app_hash,fx.init_hash,root=fx.root,now=fx.now)
        self.assertEqual(os.readlink(fx.root/'current'),'releases/'+fx.release_id)
        self.assertEqual((fx.root/s.PENDING).read_bytes(),foreign['bytes'])
        self.assertEqual((fx.root/s.PENDING).stat().st_ino,foreign['inode'])
        self.assertTrue((fx.root/'releases/old').is_dir())
        with self.assertRaises(s.ReleaseError):
            s.activate(fx.release_id,fx.manifest_hash,'releases/'+fx.release_id,fx.receipt_path,fx.receipt_hash,
                       fx.app_hash,fx.init_hash,root=fx.root,now=fx.now)

    def test_foreign_pending_is_retained_after_switch(self):self.substituted_marker(False)
    def test_same_bytes_new_inode_pending_is_retained_after_switch(self):self.substituted_marker(True)


if __name__=='__main__':unittest.main()
