#!/usr/bin/env python3
"""Reproduce one approved static manifest only after its payload matches exactly.

The approved timestamp describes the approved snapshot. This creates no API
receipt, browser evidence or activation. The source must be private build output;
unknown files, links and concurrent changes stop without a permissive fallback.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import uuid

APPROVED_SHA = 'b20e11a258007f39129a47601be7a291391c9275ad5ea6b51ab0e9e7f21aa272'
APPROVED_PATH = Path(__file__).with_name('approved-v014-release.json')
FIELDS = ('st_dev','st_ino','st_mode','st_uid','st_gid','st_nlink','st_size','st_mtime_ns','st_ctime_ns')


def release_module():
    spec = importlib.util.spec_from_file_location('_approved_static_release',Path(__file__).with_name('static-release.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class NormalizationError(Exception):
    pass


def require(value):
    if not value:
        raise NormalizationError('approved_static_bytes_or_metadata_mismatch')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def stamp(info):
    return tuple(getattr(info,k) for k in FIELDS)


def load_approved(release):
    raw = release.read_absolute(APPROVED_PATH,256*1024)
    require(digest(raw)==APPROVED_SHA)
    return raw


def snapshot(release,root,*,temporary=None):
    """Capture exact names and metadata; never open an unknown file body."""
    expected = release.FILES | {'release.json'}
    directories = {str(p) for name in expected for p in Path(name).parents if str(p)!='.'}
    result = {}
    def walk(fd,prefix=''):
        allowed = {name[len(prefix):].split('/')[0] for name in expected if name.startswith(prefix)}
        seen = set(os.listdir(fd))
        if not prefix and temporary is not None:
            require(temporary in seen);seen.remove(temporary)
        require(seen==allowed)
        for leaf in sorted(allowed):
            name = prefix+leaf
            info = os.stat(leaf,dir_fd=fd,follow_symlinks=False)
            require(not stat.S_IMODE(info.st_mode)&0o022)
            if name in directories:
                require(stat.S_ISDIR(info.st_mode))
                with release.relative_directory(fd,leaf) as child:
                    require((info.st_dev,info.st_ino)==(os.fstat(child).st_dev,os.fstat(child).st_ino))
                    walk(child,name+'/')
            else:
                require(stat.S_ISREG(info.st_mode) and info.st_nlink==1)
            result[name]=stamp(info)
    walk(root)
    return result


def normalize(source):
    release = release_module()
    approved_raw = load_approved(release)
    approved = release.strict_json(approved_raw)
    require(isinstance(approved,dict) and set(approved)=={'version','createdAt','fileCount','totalBytes','files'})
    require(approved['version']==release.VERSION and type(approved['fileCount']) is int
            and approved['fileCount']==len(release.FILES))
    source = Path(source)
    require('..' not in source.parts)
    if not source.is_absolute():source=Path.cwd()/source
    with release.directory(source) as root:
        root_info = os.fstat(root)
        require(root_info.st_uid==os.geteuid() and not stat.S_IMODE(root_info.st_mode)&0o022)
        before = snapshot(release,root)
        current_raw = release.read_file(root,'release.json',256*1024)
        current,captured = release.snapshot_fd(root,digest(current_raw))
        # All fields except createdAt describe the same exact approved bytes.
        require(all(current[key]==approved[key] for key in ('version','fileCount','totalBytes','files')))
        require(set(captured)==release.FILES|{'release.json'})
        require(snapshot(release,root)==before)
        if current_raw==approved_raw:
            release.snapshot_fd(root,APPROVED_SHA)
            return {'state':'approved_static_reproduced','changed':False,'manifestSha256':APPROVED_SHA,'fileCount':len(release.FILES)}
        temporary='.approved-manifest-'+uuid.uuid4().hex
        fd=None;replaced=False
        try:
            fd=os.open(temporary,os.O_RDWR|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=root)
            try:
                view=memoryview(approved_raw)
                while view:
                    count=os.write(fd,view);require(count>0);view=view[count:]
                os.fchmod(fd,0o644);os.fsync(fd)
                after=os.fstat(fd)
                require(stat.S_ISREG(after.st_mode) and after.st_nlink==1 and after.st_size==len(approved_raw))
                require(os.pread(fd,len(approved_raw)+1,0)==approved_raw)
                require(snapshot(release,root,temporary=temporary)==before)
                with release.directory(source) as named:
                    require((os.fstat(named).st_dev,os.fstat(named).st_ino)==(root_info.st_dev,root_info.st_ino))
                named=os.stat(temporary,dir_fd=root,follow_symlinks=False)
                require(stamp(named)==stamp(after))
                os.replace(temporary,'release.json',src_dir_fd=root,dst_dir_fd=root)
                replaced=True;os.fsync(root)
            except BaseException:
                raise
            release.snapshot_fd(root,APPROVED_SHA)
            return {'state':'approved_static_reproduced','changed':True,'manifestSha256':APPROVED_SHA,'fileCount':len(release.FILES)}
        except BaseException:
            if fd is not None and not replaced:
                try:
                    own=os.fstat(fd)
                    named=os.stat(temporary,dir_fd=root,follow_symlinks=False)
                    if (stat.S_ISREG(own.st_mode) and own.st_nlink==1
                            and own.st_uid==os.geteuid() and stamp(named)==stamp(own)):
                        # Keep the allocated inode open until this owned-only
                        # cleanup completes, preventing inode-reuse confusion.
                        os.unlink(temporary,dir_fd=root)
                except FileNotFoundError:pass
            raise
        finally:
            if fd is not None:os.close(fd)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',required=True)
    args=parser.parse_args()
    try:
        print(json.dumps(normalize(args.source),sort_keys=True))
    except BaseException:
        print('{"state":"stopped","reason":"approved_static_reproduction_failed"}')
        return 1
    return 0


if __name__=='__main__':raise SystemExit(main())
