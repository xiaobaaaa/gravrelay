#!/usr/bin/python3
"""Start the Linux workspace and its local SSH tunnel."""

import argparse
import base64
import hashlib
import glob
import ssl
import stat
import fcntl
import json
import os
from pathlib import Path, PurePosixPath
from queue import Empty, Queue
import re
import secrets
import shlex
import signal
import socket
import subprocess
import tempfile
from threading import Thread
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

COMPATIBILITY = json.loads(Path(__file__).with_name('compatibility.json').read_text())
VERSION = COMPATIBILITY['appVersion']
DATA = Path.home() / 'Library/Application Support/Antigravity SSH Preview'
APP_DATA = 'antigravity-ssh-preview'
PROXY_PORT = int(os.environ.get('AGY_SSH_PROXY_PORT', '0'))
BACKEND_CERT_SPKI = COMPATIBILITY['linuxX64']['tlsSpki']
ARTIFACT = COMPATIBILITY['linuxX64']['url']
SHA256 = COMPATIBILITY['linuxX64']['sha256']
SSH = ['/usr/bin/ssh', '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
       '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
       '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'PermitLocalCommand=no',
       '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'GatewayPorts=no']
SSH_COMMAND = [*SSH, '-o', 'ClearAllForwardings=yes']
PORT_LINE = re.compile(r'listening on \w+ port at (\d+) for HTTPS\b', re.I)
OAUTH_LINE = re.compile(r'^.*?ANTIGRAVITY_OPEN_URL: (https://accounts\.google\.com/\S+)')
SERVICE = '/exa.language_server_pb.LanguageServerService/'


ALIAS = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z')


def ssh_hosts():
    visited = set()
    hosts = set()

    def visit(path):
        path = path.resolve()
        if path in visited or len(visited) >= 64:
            return
        visited.add(path)
        try:
            lines = path.read_text(errors='replace').splitlines()
        except OSError:
            return
        for line in lines:
            try:
                parts = shlex.split(line, comments=True)
            except ValueError:
                continue
            if not parts:
                continue
            directive, equals, inline = parts[0].partition('=')
            values = ([inline] if equals and inline else []) + parts[1:]
            if values and values[0] == '=':
                values = values[1:]
            if directive.lower() == 'host':
                hosts.update(host for host in values if ALIAS.fullmatch(host))
            if directive.lower() == 'include':
                for value in values:
                    pattern = Path(value.replace('%d', str(Path.home()))).expanduser()
                    if not pattern.is_absolute():
                        pattern = Path.home() / '.ssh' / pattern
                    for match in sorted(glob.glob(str(pattern))):
                        visit(Path(match))

    visit(Path.home() / '.ssh/config')
    return sorted(hosts, key=str.casefold)


def managed_ssh_config(host):
    path = Path.home() / 'Library/Application Support/Antigravity SSH Settings/ssh-hosts' / (host + '.conf')
    try:
        info = path.lstat()
    except FileNotFoundError:
        return []
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError('The managed SSH configuration must be a private file.')
    return ['-F', str(path)]


def remote(host, command, timeout=12):
    result = subprocess.run([*SSH_COMMAND, *managed_ssh_config(host), host, command], text=True, capture_output=True,
                            timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'SSH command on {host} exited with code {result.returncode}.')
    return result.stdout.rstrip('\n')


def directory_info(host, directory):
    code = ('import json,os,sys; '
            'p=os.path.realpath(os.path.expanduser(sys.argv[1])); '
            'children=sorted(e.name for e in os.scandir(p) if e.is_dir()); '
            'print(json.dumps([p,children]))')
    return json.loads(remote(host, shlex.join(['python3', '-c', code, directory])))


def setup_backend(host, proxy_url):
    proxy_args = '--proxy ' + shlex.quote(proxy_url) + " --noproxy ''" if proxy_url else ''
    script = f'''
        set -eu
        [ "$(uname -s):$(uname -m)" = Linux:x86_64 ]
        umask 077
        dir="$HOME/.local/share/antigravity-ssh-preview/{VERSION}"
        mkdir -p -- "$dir"
        if ! printf '%s  %s\n' '{SHA256}' "$dir/language_server" | sha256sum --status -c -; then
            staged=$(mktemp "$dir/.download.XXXXXX")
            trap 'rm -f -- "$staged"' EXIT
            curl {proxy_args} --proto '=https' --proto-redir '=https' --fail --silent --show-error --location --max-time 240 \
                '{ARTIFACT}' -o "$staged"
            printf '%s  %s\n' '{SHA256}' "$staged" | sha256sum --status -c -
            chmod 700 "$staged"
            mv -f -- "$staged" "$dir/language_server"
        fi
        test -x "$dir/language_server"
        printf '%s\n' "$dir/language_server"
    '''
    return remote(host, 'bash -c ' + shlex.quote(script), timeout=265)


def terminate(proc):
    if proc is not None and proc.poll() is None:
        if proc.stdin is not None:
            proc.stdin.close()
        try:
            proc.wait(timeout=2 if proc.stdin is not None else 0.1)
        except subprocess.TimeoutExpired:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()


def forward(host, local_port, remote_port):
    proc = subprocess.Popen([*SSH, *managed_ssh_config(host), '-N', '-o', 'ExitOnForwardFailure=yes',
                             '-L', f'127.0.0.1:{local_port}:127.0.0.1:{remote_port}',
                             host], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline and proc.poll() is None:
        owner = subprocess.run(
            ['/usr/sbin/lsof', '-nP', '-a', '-p', str(proc.pid),
             '-iTCP@127.0.0.1:' + str(local_port), '-sTCP:LISTEN', '-t'],
            text=True, capture_output=True,
        )
        if str(proc.pid) in owner.stdout.split():
            return proc
        time.sleep(0.1)
    terminate(proc)
    raise RuntimeError('Could not create the local SSH tunnel. The port may be in use.')


def listeners(host, port):
    output = remote(host, 'ss -H -ltn')
    addresses = [cols[3].rsplit(':', 1)[0] for line in output.splitlines()
                 if len(cols := line.split()) >= 4 and cols[3].endswith(f':{port}')]
    if '127.0.0.1' not in addresses or any(a not in ('127.0.0.1', '[::1]') for a in addresses):
        raise RuntimeError('The remote workspace listener could not be verified as loopback-only.')


def reverse_proxy(host):
    if not PROXY_PORT:
        return None, None
    if not 1 <= PROXY_PORT <= 65535:
        raise RuntimeError('Invalid local HTTP proxy port.')
    try:
        with socket.create_connection(('127.0.0.1', PROXY_PORT), timeout=1):
            pass
    except OSError as error:
        raise RuntimeError('The configured local HTTP proxy is not reachable.') from error
    proc = subprocess.Popen(
        [*SSH, *managed_ssh_config(host), '-v', '-N', '-o', 'ExitOnForwardFailure=yes',
         '-R', f'127.0.0.1:0:127.0.0.1:{PROXY_PORT}', host],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
    )
    ports = Queue()

    def read_port():
        for line in proc.stderr:
            if match := re.search(r'Allocated port (\d+) for remote forward', line):
                ports.put(int(match[1]))
        ports.put(None)

    Thread(target=read_port, daemon=True).start()
    try:
        port = ports.get(timeout=12)
        if port is None:
            raise RuntimeError('The SSH server rejected the reverse HTTP proxy tunnel.')
        listeners(host, port)
        return proc, f'http://127.0.0.1:{port}'
    except (Empty, OSError, RuntimeError, subprocess.SubprocessError) as error:
        terminate(proc)
        if isinstance(error, Empty):
            raise RuntimeError('The reverse HTTP proxy tunnel timed out.') from None
        raise


def oauth_callback(host, url):
    parsed = urllib.parse.urlsplit(url)
    redirect = urllib.parse.parse_qs(parsed.query).get('redirect_uri', [''])[0]
    callback = urllib.parse.urlsplit(redirect)
    if (parsed.netloc != 'accounts.google.com' or parsed.path != '/o/oauth2/auth'
            or callback.scheme != 'http' or callback.hostname != 'localhost'
            or callback.path != '/auth/callback' or not callback.port):
        raise RuntimeError('Unexpected Google sign-in callback URL.')
    listeners(host, callback.port)
    tunnel = forward(host, callback.port, callback.port)
    try:
        subprocess.run(['/usr/bin/open', url], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        terminate(tunnel)
        raise RuntimeError('Could not open the Google sign-in page.') from None
    return tunnel


def rpc(browser, base, csrf, name, data, timeout=8):
    request = urllib.request.Request(
        base + SERVICE + name, json.dumps(data).encode(),
        {'Content-Type': 'application/json', 'Connect-Protocol-Version': '1',
         'X-Codeium-Csrf-Token': csrf},
    )
    try:
        with browser.open(request, timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'Antigravity {name} returned HTTP {error.code}.') from None
    except TimeoutError:
        raise RuntimeError(f'The remote Antigravity {name} request timed out.') from None


def session_status(host, directory, status, port=None):
    state = {'directory': directory, 'supervisorPID': os.getpid(), 'status': status}
    if port is not None:
        state['port'] = port
    profile = DATA / host
    with tempfile.NamedTemporaryFile(mode='w', dir=profile, prefix='.session-', delete=False) as out:
        json.dump(state, out)
        staged = Path(out.name)
    staged.replace(profile / 'session.json')


def connect(host, directory, probe, project_spec=None, start_only=False):
    effective = subprocess.check_output(
        [*SSH, *managed_ssh_config(host), '-G', host], text=True, stderr=subprocess.DEVNULL, timeout=8,
    )
    if re.search(r'^(localforward|remoteforward|dynamicforward) ', effective, re.M):
        raise RuntimeError('Choose an SSH host alias without extra port forwarding rules.')
    session_status(host, directory, 'Preparing Linux workspace')
    proxy, proxy_url = reverse_proxy(host)
    try:
        server = setup_backend(host, proxy_url)
        session_status(host, directory, 'Starting SSH workspace')
        run_backend(host, directory, server, proxy_url, probe, project_spec, start_only)
    finally:
        terminate(proxy)


def run_backend(host, directory, server, proxy_url, probe, project_spec=None, start_only=False):
    csrf = secrets.token_urlsafe(28)
    argv = [server, '--standalone', '--override_ide_name', 'antigravity',
            '--subclient_type', 'hub', '--override_ide_version', VERSION,
            '--override_user_agent_name', 'antigravity', '--https_server_port', '0',
            '--csrf_token', csrf, '--app_data_dir', APP_DATA,
            '--api_server_url', 'https://generativelanguage.googleapis.com',
            '--cloud_code_endpoint', 'https://daily-cloudcode-pa.googleapis.com',
            '--enable_sidecars', '--exit_on_stdin_close']
    backend_env = {'ANTIGRAVITY_VSCODE_HOST': '1'}
    if proxy_url:
        backend_env.update(dict.fromkeys(('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'), proxy_url))
        backend_env.update(dict.fromkeys(('NO_PROXY', 'no_proxy'), 'localhost,127.0.0.1,::1'))
    env_args = [f'{key}={value}' for key, value in backend_env.items()]
    command = ('cd -- ' + shlex.quote(directory)
               + ' && exec flock -n -E 75 "$HOME/.local/share/antigravity-ssh-preview/connection.lock" '
               + shlex.join(['env', *env_args, *argv]))
    backend = subprocess.Popen([*SSH_COMMAND, *managed_ssh_config(host), host, command], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, errors='replace')
    events = Queue()
    tunnel = callback = None

    def parse():
        for line in backend.stdout:
            if match := PORT_LINE.search(line):
                events.put(('port', int(match[1])))
            if match := OAUTH_LINE.search(line):
                events.put(('oauth', match[1]))
        events.put(('closed', None))

    Thread(target=parse, daemon=True).start()
    try:
        try:
            event, remote_port = events.get(timeout=35)
        except Empty:
            raise RuntimeError('The remote Antigravity workspace did not start in time.') from None
        if event != 'port':
            if backend.wait(timeout=2) == 75:
                raise RuntimeError('This host already has an Antigravity SSH workspace.')
            raise RuntimeError('The remote Antigravity workspace could not start.')
        listeners(host, remote_port)
        certificate = remote(
            host,
            f'timeout 45 openssl s_client -showcerts -connect 127.0.0.1:{remote_port} '
            '-servername localhost </dev/null 2>/dev/null | openssl x509 -outform PEM',
            timeout=50,
        )
        public_key = subprocess.check_output(
            ['/usr/bin/openssl', 'x509', '-pubkey', '-noout'], input=certificate.encode(),
        )
        spki = subprocess.check_output(
            ['/usr/bin/openssl', 'pkey', '-pubin', '-outform', 'DER'], input=public_key,
        )
        fingerprint = base64.b64encode(hashlib.sha256(spki).digest()).decode()
        if fingerprint != BACKEND_CERT_SPKI:
            raise RuntimeError('The remote workspace TLS fingerprint does not match this release.')
        context = ssl.create_default_context(cadata=certificate)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        tunnel = forward(host, port, remote_port)
        base = f'https://localhost:{port}'
        browser = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context),
        )
        if not start_only:
            project = project_spec['id'] if project_spec else str(uuid.uuid5(uuid.NAMESPACE_URL, f'ssh://{host}{directory}'))
            projects = rpc(browser, base, csrf, 'ListProjects', {}, timeout=45)
            if project not in projects.get('projectIds', []):
                folders = project_spec['folders'] if project_spec else [directory]
                name = project_spec['name'] if project_spec else f'{PurePosixPath(directory).name or "/"} · {host}'
                rpc(browser, base, csrf, 'CreateProject', {'project': {
                    'id': project, 'name': name,
                    'projectResources': {'resources': [
                        {'folderUri': 'file://' + urllib.parse.quote(folder)} for folder in folders
                    ]},
                }})
            if project not in rpc(browser, base, csrf, 'ListProjects', {}).get('projectIds', []):
                raise RuntimeError('The remote workspace did not save the selected project.')
        if probe:
            print(f'Registered SSH project {host} {directory}', flush=True)
            return
        session_status(host, directory, 'Connected', port)
        print('READY', flush=True)
        while True:
            if tunnel.poll() is not None or backend.poll() is not None:
                raise RuntimeError(f'The SSH session to {host} disconnected.')
            try:
                event, value = events.get(timeout=0.4)
            except Empty:
                continue
            if event == 'oauth':
                terminate(callback)
                callback = oauth_callback(host, value)
    finally:
        for proc in (callback, tunnel, backend):
            terminate(proc)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--hosts', action='store_true')
    parser.add_argument('--host')
    parser.add_argument('--directory')
    parser.add_argument('--browse', action='store_true')
    parser.add_argument('--probe', action='store_true')
    parser.add_argument('--headless', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--project-spec')
    parser.add_argument('--start-only', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.hosts:
        print(json.dumps(ssh_hosts()))
        return
    if not args.host or not ALIAS.fullmatch(args.host):
        parser.error('Invalid SSH host alias.')
    if not args.directory or not args.directory.startswith(('~', '/')):
        parser.error('Enter an absolute remote path.')
    try:
        directory, children = directory_info(args.host, args.directory)
        if args.browse:
            print(json.dumps({'path': directory, 'children': [
                name for name in children if not name.startswith('.') and '\n' not in name
            ][:400]}))
            return
        project_spec = None
        if args.project_spec:
            project_spec = json.loads(args.project_spec)
            folder_paths = project_spec['folders']
            name = project_spec['name']
            if (not isinstance(folder_paths, list) or not 1 <= len(folder_paths) <= 12
                    or folder_paths[0] != directory or not isinstance(name, str)
                    or not 1 <= len(name) <= 120):
                raise ValueError('Invalid remote project configuration.')
            project_spec['id'] = str(uuid.UUID(project_spec['id']))
            project_spec['folders'] = [directory] + [
                directory_info(args.host, folder)[0] for folder in folder_paths[1:]
            ]
        DATA.mkdir(mode=0o700, exist_ok=True)
        profile = DATA / args.host
        profile.mkdir(mode=0o700, exist_ok=True)
        with (DATA / 'window.lock').open('a') as legacy, (profile / 'connection.lock').open('a') as lock:
            try:
                fcntl.flock(legacy, fcntl.LOCK_SH | fcntl.LOCK_NB)
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError('This host already has a connection, or a legacy preview is still running.') from None
            try:
                connect(args.host, directory, args.probe, project_spec, args.start_only)
            finally:
                (profile / 'session.json').unlink(missing_ok=True)
    except (RuntimeError, OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, str(error) + '\n')


def interrupted(_signal, _frame):
    raise KeyboardInterrupt


if __name__ == '__main__':
    for sig in (signal.SIGHUP, signal.SIGTERM):
        signal.signal(sig, interrupted)
    try:
        main()
    except KeyboardInterrupt:
        pass
