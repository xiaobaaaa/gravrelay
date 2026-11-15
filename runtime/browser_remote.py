#!/usr/bin/env python3
"""Find a verified same-user Chromium CDP endpoint; start only an owned fallback."""
import fcntl
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import sys
import time
from urllib.parse import urlsplit
import uuid

BROWSER_ID = re.compile(r'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$', re.I)
CHROME_EXECUTABLES = {
    '/opt/google/chrome/chrome', '/opt/google/chrome-beta/chrome',
    '/opt/google/chrome-unstable/chrome', '/usr/lib/chromium/chromium',
    '/usr/lib/chromium-browser/chromium-browser', '/usr/lib64/chromium-browser/chromium-browser',
}
ROOT = Path.home() / '.local/share/gravrelay/browser'


def endpoint_address(value, ipv6=False):
    encoded, port = value.rsplit(':', 1)
    data = bytes.fromhex(encoded)
    if ipv6:
        data = b''.join(data[i:i + 4][::-1] for i in range(0, 16, 4))
        address = socket.inet_ntop(socket.AF_INET6, data)
    else:
        address = socket.inet_ntop(socket.AF_INET, data[::-1])
    return address, int(port, 16)


def listening_sockets(port):
    found = []
    for filename, ipv6 in [('/proc/net/tcp', False), ('/proc/net/tcp6', True)]:
        try:
            lines = Path(filename).read_text().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            fields = line.split()
            if len(fields) < 10 or fields[3] != '0A':
                continue
            address, number = endpoint_address(fields[1], ipv6)
            if number == port:
                found.append({'address': address, 'inode': fields[9]})
    return found


def chrome_owner(port, expected_pid=None):
    sockets = listening_sockets(port)
    if not sockets or any(not ipaddress.ip_address(s['address']).is_loopback for s in sockets):
        raise RuntimeError('The browser debugging port must listen only on loopback addresses.')
    inodes = {s['inode'] for s in sockets}
    candidates = [Path('/proc') / str(expected_pid)] if expected_pid else list(Path('/proc').glob('[0-9]*'))
    for process in candidates:
        try:
            if process.stat().st_uid != os.getuid():
                continue
            executable = os.readlink(process / 'exe')
            if executable not in CHROME_EXECUTABLES:
                continue
            for descriptor in (process / 'fd').iterdir():
                try:
                    target = os.readlink(descriptor)
                except OSError:
                    continue
                if target.startswith('socket:[') and target[8:-1] in inodes:
                    return int(process.name), executable
        except (OSError, ValueError):
            continue
    raise RuntimeError('The browser debugging socket does not belong to a verified same-user Chrome process.')


def validate_version(value, port):
    if not isinstance(value, dict) or not re.match(r'^(?:HeadlessChrome|Chrome|Chromium)/', value.get('Browser', '')):
        raise RuntimeError('The debugging endpoint is not Chromium.')
    url = urlsplit(value.get('webSocketDebuggerUrl', ''))
    match = re.fullmatch(r'/devtools/browser/([0-9a-f-]{36})', url.path, re.I)
    if (url.scheme != 'ws' or url.hostname not in ('127.0.0.1', 'localhost', '::1') or
            url.port != port or url.username or url.password or url.query or url.fragment or
            not match or not BROWSER_ID.fullmatch(match.group(1))):
        raise RuntimeError('The browser returned an invalid local debugging identity.')
    return match.group(1)


def probe(port, expected_pid=None, expected_browser=None):
    pid, executable = chrome_owner(port, expected_pid)
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
    try:
        connection.request('GET', '/json/version', headers={'Connection': 'close'})
        response = connection.getresponse()
        data = response.read(65537)
        if response.status != 200 or len(data) > 65536:
            raise RuntimeError('The Chrome debugging endpoint did not return a valid version response.')
        value = json.loads(data)
    finally:
        connection.close()
    browser_id = validate_version(value, port)
    if expected_browser and browser_id != expected_browser:
        raise RuntimeError('The Chrome debugging identity changed unexpectedly.')
    return {'ok': True, 'remotePort': port, 'browserId': browser_id,
            'ownerPID': pid, 'executable': executable,
            'product': value.get('Browser', ''), 'protocolVersion': value.get('Protocol-Version', '')}


def private_directory(directory):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise RuntimeError('The GravRelay browser directory must be a private same-user directory.')
    return directory


def read_state(path):
    if not path.exists():
        return None
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise RuntimeError('The GravRelay browser state file must be private.')
    value = json.loads(path.read_text())
    if (value.get('schema') != 1 or value.get('uid') != os.getuid() or
            not re.fullmatch(r'gravrelay-browser-[0-9a-f]{12}\.service', value.get('unit', '')) or
            value.get('profile') != str(ROOT / 'profile')):
        raise RuntimeError('The GravRelay browser state does not identify an owned service.')
    return value


def save_state(path, value):
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex)
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump(value, output)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def service_info(unit):
    result = subprocess.run(['systemctl', '--user', 'show', unit,
                             '--property=LoadState,ActiveState,SubState,MainPID,ExecStart,ControlGroup'],
                            capture_output=True, text=True, timeout=6)
    return dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)


def safe_proxy(value):
    try:
        url = urlsplit(value)
        if (url.scheme not in ('http', 'https', 'socks4', 'socks5') or
                url.hostname not in ('localhost', '127.0.0.1', '::1') or
                url.username or url.password or not url.port or
                url.path not in ('', '/') or url.query or url.fragment):
            return None
        return url.scheme + '://' + url.netloc
    except (ValueError, TypeError):
        return None


def cli_proxy():
    info = service_info('antigravity-cli-daemon.service')
    try:
        pid = int(info.get('MainPID', '0'))
        if pid < 1 or Path('/proc/' + str(pid)).stat().st_uid != os.getuid():
            return None
        environment = dict(part.split(b'=', 1) for part in Path('/proc/' + str(pid) + '/environ').read_bytes().split(b'\0') if b'=' in part)
        for name in ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY']:
            proxy = safe_proxy(environment.get(name.encode(), b'').decode(errors='ignore'))
            if proxy:
                return proxy
    except (OSError, ValueError):
        pass
    return None


def installed_browser():
    for name in ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']:
        executable = shutil.which(name)
        if executable:
            return executable
    raise RuntimeError('Install Google Chrome or Chromium on the SSH host before opening its browser panel.')


def owned_endpoint():
    private_directory(ROOT)
    lock_path = ROOT / 'endpoint.lock'
    descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(descriptor, 'w') as lock:
        info = os.fstat(lock.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
            raise RuntimeError('The browser lock permissions are unsafe.')
        fcntl.flock(lock, fcntl.LOCK_EX)
        state_path = ROOT / 'state.json'
        state = read_state(state_path)
        if state is None:
            profile = private_directory(ROOT / 'profile')
            state = {'schema': 1, 'uid': os.getuid(), 'unit': 'gravrelay-browser-' + uuid.uuid4().hex[:12] + '.service',
                     'profile': str(profile), 'executable': installed_browser(), 'createdAt': time.time()}
            save_state(state_path, state)
        else:
            private_directory(Path(state['profile']))
        unit = state['unit']
        info = service_info(unit)
        if info.get('LoadState') != 'not-found':
            if state['profile'] not in info.get('ExecStart', '') or state['executable'] not in info.get('ExecStart', ''):
                raise RuntimeError('The recorded browser service is not owned by GravRelay.')
            if info.get('ActiveState') != 'active':
                subprocess.run(['systemctl', '--user', 'start', unit], check=True, capture_output=True, timeout=15)
        else:
            command = [state['executable'], '--headless=new', '--no-first-run', '--no-default-browser-check',
                       '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
                       '--user-data-dir=' + state['profile']]
            proxy = cli_proxy()
            if proxy:
                command += ['--proxy-server=' + proxy, '--proxy-bypass-list=localhost;127.0.0.1;[::1]']
            command += ['about:blank']
            subprocess.run(['systemd-run', '--user', '--unit=' + unit, '--property=Restart=on-failure',
                            '--property=RestartSec=3', '--property=WorkingDirectory=' + str(ROOT)] + command,
                           check=True, capture_output=True, timeout=15)
        deadline = time.monotonic() + 18
        while time.monotonic() < deadline:
            info = service_info(unit)
            try:
                pid = int(info.get('MainPID', '0'))
                active_port = Path(state['profile']) / 'DevToolsActivePort'
                port_info = active_port.read_text().splitlines()
                port = int(port_info[0])
                browser_id = port_info[1].removeprefix('/devtools/browser/')
                if pid > 0 and 1024 <= port <= 65535 and BROWSER_ID.fullmatch(browser_id):
                    result = probe(port, pid, browser_id)
                    result.update({'owned': True, 'unit': unit})
                    state.update({'browserId': browser_id, 'remotePort': port, 'ownerPID': pid})
                    save_state(state_path, state)
                    return result
            except (OSError, ValueError, RuntimeError, IndexError, json.JSONDecodeError):
                pass
            if info.get('ActiveState') == 'failed':
                raise RuntimeError('The owned Chrome process could not start. Check the SSH host Chrome installation and sandbox support.')
            time.sleep(0.25)
        raise RuntimeError('The owned Chrome process did not expose a verified debugging endpoint in time.')


def ensure():
    try:
        result = probe(9223)
        result['owned'] = False
        return result
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError):
        return owned_endpoint()


def main():
    try:
        print(json.dumps(ensure()))
    except Exception as error:
        # Never echo process environments, credentials, or full command output.
        print(json.dumps({'ok': False, 'message': str(error) if isinstance(error, RuntimeError) else
                          'Could not prepare the SSH browser. Check its Chrome installation and user service.'}))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
