"""Remote CLI inspection and explicit update; never restarts an active daemon."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import base64
import re
import shutil
import stat
import socket
import ssl
import struct
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request

MANIFEST_BASE = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/'
UNIT = 'antigravity-cli-daemon.service'
MAX_PACKAGE = 512 * 1024 * 1024


def version_tuple(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', value):
        raise ValueError('Invalid CLI version.')
    return tuple(map(int, value.split('.')))


def validate_manifest(value):
    version_tuple(value.get('version'))
    url = urllib.parse.urlsplit(value.get('url', ''))
    if url.scheme != 'https' or url.netloc != 'storage.googleapis.com' or url.query or url.fragment or not (
            url.path.startswith('/antigravity-public/antigravity-cli/' + value['version'] + '-')):
        raise ValueError('The CLI package must come from the official Google release storage.')
    if not re.fullmatch(r'[0-9a-f]{128}', value.get('sha512', '')):
        raise ValueError('The CLI release manifest has no valid SHA-512 checksum.')
    return {key:value[key] for key in ('version','url','sha512')}


def private_directory(path):
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError('The CLI update directory must be private and owned by this user.')


def atomic_json(path, value):
    descriptor, name = tempfile.mkstemp(dir=path.parent, prefix='.status-')
    try:
        with os.fdopen(descriptor,'w') as output:
            json.dump(value,output)
        os.replace(name,path)
    finally:
        Path(name).unlink(missing_ok=True)


def binary_version(binary):
    result = subprocess.run([str(binary),'--version'],capture_output=True,text=True,timeout=12)
    text = result.stdout.strip()
    if result.returncode or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',text):
        raise RuntimeError('The remote CLI did not return a valid version.')
    return text


def service_pid():
    result = subprocess.run(['systemctl','--user','show',UNIT,'-p','MainPID','--value'],
                            capture_output=True,text=True,timeout=10)
    return int(result.stdout.strip() or '0') if result.returncode == 0 else 0


def inspect(home):
    command = shutil.which('agy') or str(home/'.local/bin/agy')
    binary = Path(command).resolve(strict=True)
    pid = service_pid()
    running = None
    if pid > 1:
        process = Path('/proc')/str(pid)
        if process.stat().st_uid != os.getuid() or not (process/'cgroup').read_text().strip().endswith('/'+UNIT):
            raise RuntimeError('The running CLI does not belong to the expected user service.')
        executable = Path(os.readlink(process/'exe').removesuffix(' (deleted)')).resolve()
        if executable != binary:
            raise RuntimeError('The running CLI and installed CLI resolve to different paths.')
        running = binary_version(process/'exe')
    return binary, {'installedVersion':binary_version(binary),'runningVersion':running,'backendPID':pid or None}


def latest_manifest(directory, force=False):
    cache = directory/'manifest.json'
    if not force and cache.exists() and not cache.is_symlink() and time.time()-cache.stat().st_mtime < 6*3600:
        return validate_manifest(json.loads(cache.read_text()))
    system = platform.system()
    machine = platform.machine()
    if system != 'Linux' or machine not in ('x86_64','aarch64','arm64'):
        raise RuntimeError('CLI update checking currently supports Linux x64 and arm64 hosts.')
    name = 'linux_amd64' if machine == 'x86_64' else 'linux_arm64'
    if platform.libc_ver()[0] == 'musl':
        name += '_musl'
    with urllib.request.urlopen(MANIFEST_BASE+name+'.json',timeout=15) as response:
        data = response.read(65537)
    if len(data)>65536:
        raise ValueError('CLI release manifest is unexpectedly large.')
    value=validate_manifest(json.loads(data));atomic_json(cache,value)
    return value


def install(binary, manifest, directory):
    home=Path.home().resolve()
    binary=binary.resolve(strict=True)
    if home not in binary.parents:
        raise RuntimeError('Use the existing package manager to update a system-wide CLI.')
    info=binary.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode & 0o022:
        raise RuntimeError('The CLI binary must be a user-owned regular file without shared write access.')
    old_bytes=binary.read_bytes()
    before=hashlib.sha256(old_bytes).hexdigest()
    with tempfile.TemporaryDirectory(prefix='package-',dir=directory) as staging:
        staging=Path(staging);package=staging/'package';digest=hashlib.sha512();total=0
        with urllib.request.urlopen(manifest['url'],timeout=30) as response,package.open('wb') as output:
            final=urllib.parse.urlsplit(response.geturl())
            if final.scheme!='https' or final.netloc!='storage.googleapis.com':
                raise RuntimeError('Unexpected CLI package redirect.')
            while True:
                block=response.read(1024*1024)
                if not block:break
                total+=len(block)
                if total>MAX_PACKAGE:raise RuntimeError('CLI package exceeds the download limit.')
                digest.update(block);output.write(block)
        if digest.hexdigest()!=manifest['sha512']:
            raise RuntimeError('CLI package SHA-512 verification failed.')
        candidate=staging/'agy'
        if urllib.parse.urlsplit(manifest['url']).path.endswith('.tar.gz'):
            with tarfile.open(package,'r:gz') as archive:
                entries=[member for member in archive.getmembers() if member.name in ('antigravity','./antigravity')]
                if len(entries)!=1 or not entries[0].isfile() or entries[0].size>MAX_PACKAGE:
                    raise RuntimeError('The CLI archive has no safe executable entry.')
                with archive.extractfile(entries[0]) as source,candidate.open('wb') as output:
                    shutil.copyfileobj(source,output)
        else:shutil.copyfile(package,candidate)
        candidate.chmod(0o700)
        if binary_version(candidate)!=manifest['version']:
            raise RuntimeError('The staged CLI version differs from its verified manifest.')
        if hashlib.sha256(binary.read_bytes()).hexdigest()!=before:
            raise RuntimeError('The CLI changed during staging; retry after its updater finishes.')
        backup=directory/('agy-before-'+before)
        if backup.exists():
            meta=backup.lstat()
            if not stat.S_ISREG(meta.st_mode) or meta.st_uid!=os.getuid() or meta.st_mode & 0o077 or hashlib.sha256(backup.read_bytes()).hexdigest()!=before:
                raise RuntimeError('The existing CLI backup does not match the verified old binary.')
        else:
            descriptor=os.open(backup,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o700)
            with os.fdopen(descriptor,'wb') as output:output.write(old_bytes)

        descriptor,name=tempfile.mkstemp(prefix='.agy-update-',dir=binary.parent)
        try:
            with os.fdopen(descriptor,'wb') as output:
                with candidate.open('rb') as source:shutil.copyfileobj(source,output)
                output.flush();os.fsync(output.fileno())
            os.chmod(name,info.st_mode & 0o777)
            if hashlib.sha256(binary.read_bytes()).hexdigest()!=before:
                raise RuntimeError('The CLI changed during staging; retry after its updater finishes.')
            os.replace(name,binary)
        finally:Path(name).unlink(missing_ok=True)


def idle_snapshot(port, pin):
    probe=ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT);probe.check_hostname=False;probe.verify_mode=ssl.CERT_NONE
    with socket.create_connection(('127.0.0.1',port),5) as tcp:
        with probe.wrap_socket(tcp,server_hostname='localhost') as stream:
            pem=ssl.DER_cert_to_PEM_cert(stream.getpeercert(binary_form=True))
    public=subprocess.check_output(['openssl','x509','-pubkey','-noout'],input=pem.encode())
    key=subprocess.check_output(['openssl','pkey','-pubin','-outform','DER'],input=public)
    if base64.b64encode(hashlib.sha256(key).digest()).decode()!=pin:
        raise RuntimeError('The CLI restart probe did not match the supported TLS key.')
    token_file=Path.home()/'.config/gravrelay/cli.env';info=token_file.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode & 0o077:
        raise RuntimeError('Unsafe CLI connection configuration.')
    token=token_file.read_text().strip().partition('=')[2]
    if not re.fullmatch(r'[A-Za-z0-9_-]{32,128}',token):raise RuntimeError('Invalid CLI connection configuration.')
    context=ssl.create_default_context(cadata=pem)
    browser=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=context))
    request=urllib.request.Request('https://localhost:'+str(port)+'/exa.language_server_pb.LanguageServerService/JetboxSubscribeToSummaries',
        struct.pack('>BI',0,2)+b'{}',{'Content-Type':'application/connect+json','Connect-Protocol-Version':'1','X-Codeium-Csrf-Token':token})
    with browser.open(request,timeout=12) as response:
        header=response.read(5)
        if len(header)!=5:raise RuntimeError('Could not verify active remote tasks.')
        flags,size=struct.unpack('>BI',header)
        if flags or size>8*1024*1024:raise RuntimeError('Invalid remote task state.')
        message=json.loads(response.read(size))
    summaries=message.get('updates')
    if not isinstance(summaries,dict):raise RuntimeError('Remote task state is not initialized.')
    idle=(None,0,1,'CASCADE_RUN_STATUS_UNSPECIFIED','CASCADE_RUN_STATUS_IDLE')
    if any(s.get('status') not in idle or s.get('hasRunningSubagents') or s.get('notFullyIdle') for s in summaries.values()):
        raise RuntimeError('Remote tasks are still running. Finish them before restarting the CLI.')


def owns_port(pid, port):
    process=Path('/proc')/str(pid);inodes=set()
    for fd in (process/'fd').iterdir():
        try:
            link=os.readlink(fd)
            if link.startswith('socket:['):inodes.add(link[8:-1])
        except OSError:pass
    for table in ('tcp','tcp6'):
        for row in (process/'net'/table).read_text().splitlines()[1:]:
            fields=row.split()
            if fields[3]=='0A' and fields[9] in inodes:
                address,value=fields[1].rsplit(':',1)
                if int(value,16)==port and address in ('0100007F','00000000000000000000000001000000'):
                    return True
    return False


def run(operation,port=0,pin=''):
    if operation not in ('check','refresh','update','restart'):
        raise ValueError('Unsupported CLI update operation.')
    home=Path.home();directory=home/'.cache/gravrelay-cli-updates';private_directory(directory)
    lock=directory/'update.lock'
    if lock.is_symlink():raise RuntimeError('Unsafe CLI update lock path.')
    with lock.open('a') as guard:
        fcntl.flock(guard,fcntl.LOCK_EX|fcntl.LOCK_NB)
        binary,result=inspect(home)
        manifest=latest_manifest(directory,operation in ('refresh','update'))
        if operation=='restart':
            if not result['backendPID']:raise RuntimeError('The CLI service is not running. Reconnect the host to start it.')
            if result['backendPID']:
                if not 1024<=port<=65535 or not pin:raise RuntimeError('A verified CLI connection is required for restart.')
                if not owns_port(result['backendPID'],port):raise RuntimeError('The CLI listener no longer belongs to the expected service. Reconnect first.')
                idle_snapshot(port,pin);time.sleep(1);idle_snapshot(port,pin)
                if service_pid()!=result['backendPID']:raise RuntimeError('The CLI process changed; reconnect before restarting.')
                command=subprocess.run(['systemctl','--user','restart',UNIT],capture_output=True,text=True,timeout=30)
                if command.returncode:raise RuntimeError('The remote CLI service could not restart.')
            # Confirm a new executable really started; never report a timed-out restart as success.
            previous_pid=result['backendPID'];started=None
            for _ in range(30):
                try:
                    binary,result=inspect(home)
                    if result['backendPID'] and result['backendPID']!=previous_pid and result['runningVersion']==result['installedVersion']:
                        started=result;break
                except (OSError,RuntimeError):pass
                time.sleep(.2)
            if started is None:raise RuntimeError('The new CLI process did not finish starting. Check the remote service before retrying.')
            result=started
        result.update(latestVersion=manifest['version'],checkedAt=time.time())
        if operation=='update' and version_tuple(result['installedVersion'])<version_tuple(manifest['version']):
            install(binary,manifest,directory)
            _,result=inspect(home);result.update(latestVersion=manifest['version'],checkedAt=time.time())
        result['updateAvailable']=version_tuple(result['installedVersion'])<version_tuple(manifest['version'])
        result['restartRequired']=bool(result['runningVersion'] and version_tuple(result['installedVersion'])>version_tuple(result['runningVersion']))
        result['state']='restart_required' if result['restartRequired'] else 'available' if result['updateAvailable'] else 'current'
        # No service restart: active tasks and scheduled timers remain owned by the same daemon.
        atomic_json(directory/'status.json',result)
        return result


if __name__=='__main__':
    try:print(json.dumps({'ok':True,'status':run(sys.argv[1],int(sys.argv[2]),sys.argv[3])}))
    except Exception as error:
        print(json.dumps({'ok':False,'message':str(error)}))
