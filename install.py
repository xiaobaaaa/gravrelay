#!/usr/bin/env python3
"""Install the GravRelay for the current macOS user."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / 'runtime'
COMPATIBILITY = json.loads((SOURCE / 'compatibility.json').read_text())
RELEASE = '0.2.7'
LABEL = 'local.antigravity.ssh-settings'
RUNTIME = ('agent.cjs', 'panel.js', 'connect.py', 'switch-project.py', 'transport.py', 'remote_cli.py', 'cli-frontend.cjs', 'permissions.cjs', 'files.cjs', 'app-compatibility.cjs', 'compatibility.json')


class InstallError(RuntimeError):
    pass


def command(*args):
    return subprocess.run(args, capture_output=True, text=True, timeout=20)


def job(domain):
    return command('/bin/launchctl', 'print', f'{domain}/{LABEL}')


def managed_plist(file):
    if not file.exists():
        return None
    if file.is_symlink():
        raise InstallError('The LaunchAgent path is a symbolic link.')
    try:
        data = file.read_bytes()
        if plistlib.loads(data).get('Label') != LABEL:
            raise ValueError()
        return data
    except (ValueError, OSError, plistlib.InvalidFileException) as error:
        raise InstallError('The LaunchAgent file is not recognized.') from error


def runtime_path(home):
    digest = hashlib.sha256()
    for name in RUNTIME:
        digest.update((SOURCE / name).read_bytes())
    return (home / 'Library/Application Support/Antigravity SSH Settings' / 'releases'
            / (RELEASE + '-' + digest.hexdigest()[:12]))


def atomic_write(file, contents):
    with tempfile.NamedTemporaryFile(dir=file.parent, prefix='.agy-ssh-', delete=False) as staged:
        temporary = Path(staged.name)
        staged.write(contents)
    try:
        temporary.replace(file)
    finally:
        temporary.unlink(missing_ok=True)


def stage_runtime(destination):
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if destination.exists():
        if destination.is_symlink() or any((destination / name).is_symlink() or
            (destination / name).read_bytes() != (SOURCE / name).read_bytes() for name in RUNTIME):
            raise InstallError('The installed release files have changed.')
        return
    temporary = Path(tempfile.mkdtemp(prefix='.install-', dir=destination.parent))
    try:
        for name in RUNTIME:
            shutil.copyfile(SOURCE / name, temporary / name)
            (temporary / name).chmod(0o600)
        temporary.rename(destination)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def find_app(home, requested):
    candidates = [requested] if requested else [
        Path('/Applications/Antigravity.app'), home / 'Applications/Antigravity.app',
    ]
    for candidate in candidates:
        app = candidate.expanduser().resolve()
        if (app / 'Contents/Info.plist').is_file():
            return app
    raise InstallError('Install Antigravity first or pass its bundle path with --app.')


def app_version(app):
    with (app / 'Contents/Info.plist').open('rb') as metadata:
        return plistlib.load(metadata).get('CFBundleShortVersionString', '')


def verify_app(app):
    version = app_version(app)
    versions = COMPATIBILITY.get('supportedAppVersions', [COMPATIBILITY['appVersion']])
    if not isinstance(versions, list) or not versions or any(not isinstance(value, str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', value) for value in versions):
        raise InstallError('The supported application versions are invalid.')
    if version not in versions:
        raise InstallError(f"This release supports Antigravity {', '.join(versions)}. Found {version or 'unknown'}.")
    requirement = ('=anchor apple generic and identifier "' + COMPATIBILITY['bundleId']
                   + '" and certificate leaf[subject.OU] = "' + COMPATIBILITY['teamId'] + '"')
    if command('/usr/bin/codesign', '--verify', '--strict', '-R', requirement, str(app)).returncode:
        raise InstallError('The Antigravity app signature could not be verified.')


def find_node(home, requested):
    candidates = [requested] if requested else [
        shutil.which('node'), '/opt/homebrew/bin/node', '/usr/local/bin/node', home / '.local/bin/node',
    ]
    for candidate in candidates:
        if not candidate:
            continue
        node = Path(candidate).expanduser().resolve()
        if not node.is_file() or not os.access(node, os.X_OK):
            continue
        result = command(str(node), '-p', 'process.versions.node')
        if result.returncode == 0 and re.match(r'^\d+\.', result.stdout):
            if int(result.stdout.split('.')[0]) >= COMPATIBILITY['minimumNodeMajor']:
                return node
    raise InstallError(f"Node.js {COMPATIBILITY['minimumNodeMajor']} or newer is required.")


def require_idle(domain):
    state = job(domain)
    if state.returncode == 0 and re.search(r'^\s*pid = \d+', state.stdout, re.MULTILINE):
        raise InstallError('Quit Antigravity before updating or uninstalling the bridge.')
    return state.returncode == 0


def unload(domain):
    result = command('/bin/launchctl', 'bootout', f'{domain}/{LABEL}')
    if result.returncode:
        raise InstallError('Could not unload the existing bridge LaunchAgent.')
    for _ in range(12):
        if job(domain).returncode:
            return
        time.sleep(0.15)
    raise InstallError('The existing bridge LaunchAgent did not finish unloading.')


def install(home, domain, file, app, node, proxy_port):
    old = managed_plist(file)
    loaded = require_idle(domain)
    destination = runtime_path(home)
    stage_runtime(destination)
    file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    profile = home / 'Library/Application Support/Antigravity/DevToolsActivePort'
    settings = home / 'Library/Application Support/Antigravity SSH Settings'
    env = {'AGY_SSH_APP': str(app), 'AGY_SSH_PYTHON': str(Path(sys.executable).resolve())}
    if proxy_port not in (None, 0):
        raise InstallError('CLI mode needs a proxy on the SSH host; a reverse Mac proxy cannot keep remote tasks connected when the Mac disconnects.')
    plist = {
        'Label': LABEL,
        'ProgramArguments': [str(node), str(destination / 'agent.cjs')],
        'EnvironmentVariables': env,
        'RunAtLoad': True,
        'StartInterval': 60,
        'ThrottleInterval': 3,
        'WatchPaths': [str(profile)],
        'StandardErrorPath': str(settings / 'bridge.log'),
    }
    # Launchd creates the log before starting the process.
    log = settings / 'bridge.log'
    if log.is_symlink():
        raise InstallError('The bridge log path is a symbolic link.')
    if not log.exists():
        log.touch(mode=0o600, exist_ok=False)
    if loaded:
        unload(domain)
    try:
        atomic_write(file, plistlib.dumps(plist))
        result = command('/bin/launchctl', 'bootstrap', domain, str(file))
        if result.returncode:
            raise InstallError('Could not load the bridge. Run the installer from your macOS desktop login.')
    except (InstallError, OSError, subprocess.SubprocessError):
        if old is None:
            file.unlink(missing_ok=True)
        else:
            atomic_write(file, old)
            if loaded:
                restored = command('/bin/launchctl', 'bootstrap', domain, str(file))
                if restored.returncode:
                    raise InstallError('The previous LaunchAgent file was restored, but launchd could not reload it.')
        raise
    print(f'Installed GravRelay {RELEASE}. Open Antigravity and go to Settings → Connections.')


def parse_port(value):
    port = int(value)
    if not 0 <= port <= 65535:
        raise argparse.ArgumentTypeError('Use a port from 1 to 65535, or 0 to disable the proxy.')
    return port


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('install', 'doctor', 'uninstall'), nargs='?', default='install')
    parser.add_argument('--app', type=Path, help='path to Antigravity.app')
    parser.add_argument('--node', type=Path, help='path to the Node.js executable')
    parser.add_argument('--proxy-port', type=parse_port, help='legacy option; CLI mode accepts only 0 and uses the SSH host network')
    args = parser.parse_args()
    if platform.system() != 'Darwin' or os.getuid() == 0:
        raise InstallError('Run this from a normal macOS desktop account.')
    if sys.version_info < (3, 9):
        raise InstallError('Python 3.9 or newer is required.')
    home = Path.home()
    domain = f'gui/{os.getuid()}'
    file = home / 'Library/LaunchAgents' / f'{LABEL}.plist'

    if args.action == 'uninstall':
        if managed_plist(file) is None:
            print('The bridge is not installed.')
            return
        if require_idle(domain):
            unload(domain)
        file.unlink()
        print('Disabled the bridge. Saved projects and remote workspace data are kept.')
        return

    current = managed_plist(file)
    installed = plistlib.loads(current).get('EnvironmentVariables', {}) if current else {}
    app = find_app(home, args.app or (Path(installed['AGY_SSH_APP']) if installed.get('AGY_SSH_APP') else None))
    verify_app(app)
    node = find_node(home, args.node)
    if args.action == 'doctor':
        print(f'Antigravity {app_version(app)} signature verified.')
        print(f'Node.js {command(str(node), "-p", "process.versions.node").stdout.strip()}.')
        print(f'Python {platform.python_version()}.')
        print('LaunchAgent ' + ('loaded.' if job(domain).returncode == 0 else 'not loaded.'))
        return
    install(home, domain, file, app, node, args.proxy_port)


if __name__ == '__main__':
    try:
        main()
    except (InstallError, OSError, subprocess.SubprocessError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
