import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('cli_updater',ROOT/'runtime/cli_update_remote.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


def manifest(version='1.5.8'):
    return {'version':version,'url':'https://storage.googleapis.com/antigravity-public/antigravity-cli/'+version+'-123/linux-x64/cli.tar.gz','sha512':'0'*128}


class PolicyTests(unittest.TestCase):
    def test_manifest_requires_the_official_https_storage_version_and_checksum(self):
        self.assertEqual(module.validate_manifest(manifest()),manifest())
        for key,value in [('url','http://storage.googleapis.com/package'),('url','https://evil.test/pkg'),('version','latest'),('sha512','bad')]:
            item=manifest();item[key]=value
            with self.assertRaises((ValueError,TypeError)):module.validate_manifest(item)

    def test_plain_check_does_not_install_or_restart(self):
        with tempfile.TemporaryDirectory() as d, patch.object(module.Path,'home',return_value=Path(d)),patch.object(
                module,'inspect',return_value=(Path(d)/'agy',{'installedVersion':'1.5.3','runningVersion':'1.5.3','backendPID':42})),patch.object(
                module,'latest_manifest',return_value=manifest()),patch.object(module,'install') as install,patch.object(module.subprocess,'run') as command:
            result=module.run('check')
            self.assertEqual(result['state'],'available');self.assertFalse(result['restartRequired'])
            install.assert_not_called();command.assert_not_called()

    def test_update_installs_next_version_but_keeps_the_old_daemon(self):
        with tempfile.TemporaryDirectory() as d,patch.object(module.Path,'home',return_value=Path(d)),patch.object(
                module,'inspect',side_effect=[(Path(d)/'agy',{'installedVersion':'1.5.3','runningVersion':'1.5.3','backendPID':42}),
                (Path(d)/'agy',{'installedVersion':'1.5.8','runningVersion':'1.5.3','backendPID':42})]),patch.object(
                module,'latest_manifest',return_value=manifest()),patch.object(module,'install') as install,patch.object(module.subprocess,'run') as command:
            result=module.run('update')
            install.assert_called_once();command.assert_not_called();self.assertEqual(result['state'],'restart_required');self.assertEqual(result['backendPID'],42)

    def test_update_never_downgrades_an_already_newer_installation(self):
        with tempfile.TemporaryDirectory() as d,patch.object(module.Path,'home',return_value=Path(d)),patch.object(
                module,'inspect',return_value=(Path(d)/'agy',{'installedVersion':'1.6.0','runningVersion':'1.6.0','backendPID':42})),patch.object(
                module,'latest_manifest',return_value=manifest()),patch.object(module,'install') as install:
            self.assertEqual(module.run('update')['state'],'current');install.assert_not_called()

    def test_failed_or_unknown_activity_probe_never_restarts_the_daemon(self):
        with tempfile.TemporaryDirectory() as d,patch.object(module.Path,'home',return_value=Path(d)),patch.object(
                module,'inspect',return_value=(Path(d)/'agy',{'installedVersion':'1.5.8','runningVersion':'1.5.3','backendPID':42})),patch.object(
                module,'idle_snapshot',side_effect=RuntimeError('Tasks are active')) as idle,patch.object(module,'latest_manifest',return_value=manifest()),patch.object(module,'owns_port',return_value=True),patch.object(module.subprocess,'run') as command:
            with self.assertRaises(RuntimeError):module.run('restart',43043,'trusted-pin')
            command.assert_not_called();idle.assert_called_once()

    def test_manifest_cache_avoids_a_network_fetch_during_regular_reconnect(self):
        with tempfile.TemporaryDirectory() as d,patch.object(module.urllib.request,'urlopen') as fetch:
            root=Path(d);(root/'manifest.json').write_text(json.dumps(manifest()))
            self.assertEqual(module.latest_manifest(root),manifest());fetch.assert_not_called()


class Download(io.BytesIO):
    def __init__(self,data,url):super().__init__(data);self.url=url
    def geturl(self):return self.url


class PackageTests(unittest.TestCase):
    def fixture(self,root,member='antigravity'):
        binary=root/'.local/bin/agy';binary.parent.mkdir(parents=True);binary.write_bytes(b'old executable');binary.chmod(0o700)
        private=root/'updates';private.mkdir(mode=0o700)
        buffer=io.BytesIO()
        with tarfile.open(fileobj=buffer,mode='w:gz') as archive:
            entry=tarfile.TarInfo(member);entry.size=len(b'new executable');archive.addfile(entry,io.BytesIO(b'new executable'))
        payload=buffer.getvalue();item=manifest();item['sha512']=hashlib.sha512(payload).hexdigest()
        return binary,private,payload,item

    def test_verified_binary_is_atomically_replaced_and_a_running_inode_stays_readable(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);binary,private,payload,item=self.fixture(root)
            with binary.open('rb') as running,patch.object(module.Path,'home',return_value=root),patch.object(
                    module.urllib.request,'urlopen',return_value=Download(payload,item['url'])),patch.object(module,'binary_version',return_value='1.5.8'):
                module.install(binary,item,private)
                self.assertEqual(binary.read_bytes(),b'new executable');self.assertEqual(running.read(),b'old executable')
                backups=list(private.glob('agy-before-*'));self.assertEqual(len(backups),1);self.assertEqual(backups[0].read_bytes(),b'old executable')

    def test_bad_checksum_or_unsafe_archive_preserves_the_existing_binary(self):
        for bad_archive in (False,True):
            with tempfile.TemporaryDirectory() as d:
                root=Path(d);binary,private,payload,item=self.fixture(root,'../agy' if bad_archive else 'antigravity')
                if not bad_archive:item['sha512']='0'*128
                with patch.object(module.Path,'home',return_value=root),patch.object(module.urllib.request,'urlopen',return_value=Download(payload,item['url'])):
                    with self.assertRaises(RuntimeError):module.install(binary,item,private)
                self.assertEqual(binary.read_bytes(),b'old executable')

    def test_concurrent_native_updater_change_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);binary,private,payload,item=self.fixture(root)
            def version(_):binary.write_bytes(b'changed by native updater');return '1.5.8'
            with patch.object(module.Path,'home',return_value=root),patch.object(module.urllib.request,'urlopen',return_value=Download(payload,item['url'])),patch.object(module,'binary_version',side_effect=version):
                with self.assertRaises(RuntimeError):module.install(binary,item,private)
            self.assertEqual(binary.read_bytes(),b'changed by native updater')


class RestartStatusTests(unittest.TestCase):
    def test_inactive_daemon_is_not_reported_as_restarted(self):
        with tempfile.TemporaryDirectory() as d,patch.object(module.Path,'home',return_value=Path(d)),patch.object(
                module,'inspect',return_value=(Path(d)/'agy',{'installedVersion':'1.5.8','runningVersion':None,'backendPID':None})),patch.object(
                module,'latest_manifest',return_value=manifest()),patch.object(module.subprocess,'run') as command:
            with self.assertRaises(RuntimeError):module.run('restart',43043,'trusted-pin')
            command.assert_not_called()


    def test_explicit_idle_restart_requires_a_verified_new_process(self):
        old={'installedVersion':'1.5.8','runningVersion':'1.5.3','backendPID':42}
        new={'installedVersion':'1.5.8','runningVersion':'1.5.8','backendPID':43}
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as d,patch.object(module.Path,'home',return_value=Path(d)),patch.object(
                module,'inspect',side_effect=[(Path(d)/'agy',old),(Path(d)/'agy',new)]),patch.object(
                module,'latest_manifest',return_value=manifest()),patch.object(module,'owns_port',return_value=True),patch.object(
                module,'idle_snapshot') as idle,patch.object(module,'service_pid',return_value=42),patch.object(module.time,'sleep'),patch.object(
                module.subprocess,'run',return_value=SimpleNamespace(returncode=0)) as command:
            result=module.run('restart',43043,'trusted-pin');self.assertEqual(result['backendPID'],43)
            self.assertEqual(idle.call_count,2);command.assert_called_once()

    def test_unresponsive_new_daemon_is_not_reported_as_success(self):
        old={'installedVersion':'1.5.8','runningVersion':'1.5.3','backendPID':42}
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as d,patch.object(module.Path,'home',return_value=Path(d)),patch.object(
                module,'inspect',return_value=(Path(d)/'agy',old)),patch.object(module,'latest_manifest',return_value=manifest()),patch.object(
                module,'owns_port',return_value=True),patch.object(module,'idle_snapshot'),patch.object(module,'service_pid',return_value=42),patch.object(
                module.time,'sleep'),patch.object(module.subprocess,'run',return_value=SimpleNamespace(returncode=0)):
            with self.assertRaisesRegex(RuntimeError,'did not finish starting'):module.run('restart',43043,'trusted-pin')
