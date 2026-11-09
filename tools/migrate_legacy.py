#!/usr/bin/env python3
"""Plan or apply a local migration from a retired GravRelay backend to the CLI."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import subprocess
import tempfile
import time

PARTS = ('conversations', 'annotations', 'brain')


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def logical_digest(connection):
    result = hashlib.sha256()
    for line in connection.iterdump():
        result.update(line.encode())
        result.update(b'\n')
    return result.hexdigest()


def backup_existing(path, backup):
    backup.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.is_symlink():
        backup.symlink_to(os.readlink(path))
    else:
        shutil.copy2(path, backup)


def copy_entry(source, destination, backup):
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    exists = destination.exists() or destination.is_symlink()
    if source.is_symlink():
        target = os.readlink(source)
        if exists and destination.is_symlink() and os.readlink(destination) == target:
            return {'method': 'unchanged_symlink'}
        if exists:
            backup_existing(destination, backup)
            destination.unlink()
        destination.symlink_to(target)
        return {'method': 'symlink', 'target': target}
    if not source.is_file():
        raise RuntimeError('Unexpected migration entry type.')
    journal = Path(str(source) + '-journal')
    if journal.exists() and journal.stat().st_size:
        raise RuntimeError('Recover the source SQLite rollback journal before migrating this file.')
    before = digest(source)
    if exists and not destination.is_symlink() and digest(destination) == before and not os.path.samefile(source, destination):
        return {'method': 'unchanged', 'sourceSHA256': before, 'targetSHA256': before}
    with tempfile.NamedTemporaryFile(dir=destination.parent, prefix='.gravrelay-migration-', delete=False) as out:
        staged = Path(out.name)
    try:
        wal = Path(str(source) + '-wal')
        with source.open('rb') as original_file:
            sqlite_database = original_file.read(16) == b'SQLite format 3\x00'
        sqlite_backup = sqlite_database and wal.exists() and wal.stat().st_size > 0
        if sqlite_backup:
            with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True, timeout=10) as original:
                with sqlite3.connect(staged) as copied:
                    original.backup(copied, pages=4096, sleep=.01)
                    if logical_digest(original) != logical_digest(copied):
                        raise RuntimeError('SQLite logical contents did not match.')
        else:
            shutil.copy2(source, staged)
            if digest(staged) != before or digest(source) != before:
                raise RuntimeError('The source changed or the copy did not match.')
        if sqlite_database:
            with sqlite3.connect(staged.as_uri() + '?mode=ro', uri=True) as database:
                if database.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                    raise RuntimeError('The copied conversation database failed its integrity check.')
        result = {'method': 'sqlite_backup' if sqlite_backup else 'copy', 'sourceSHA256': before, 'targetSHA256': digest(staged)}
        if exists:
            backup_existing(destination, backup)
        os.chmod(staged, stat.S_IMODE(source.stat().st_mode))
        os.replace(staged, destination)
        return result
    finally:
        staged.unlink(missing_ok=True)


def source_processes(profile):
    found = []
    for proc in Path('/proc').iterdir():
        if not proc.name.isdecimal():
            continue
        try:
            if proc.stat().st_uid != os.getuid():
                continue
            args = (proc / 'cmdline').read_bytes().split(b'\0')
            for option in (b'--app_data_dir', b'--app-data-dir'):
                if option in args and args[args.index(option) + 1].decode() == profile:
                    found.append(int(proc.name))
                    break
        except (OSError, IndexError):
            pass
    return found


def entries(source):
    for name in PARTS:
        root = source / name
        if not root.exists():
            continue
        for parent, directories, files in os.walk(root, followlinks=False):
            current = Path(parent)
            for item in list(directories):
                path = current / item
                if path.is_symlink():
                    directories.remove(item)
                    yield path
            for item in files:
                if item.endswith(('-wal', '-shm')) or item.startswith('.gravrelay-migration-'):
                    continue
                yield current / item


def cli_processes():
    found = []
    for proc in Path('/proc').iterdir():
        if not proc.name.isdecimal():
            continue
        try:
            executable = os.readlink(proc / 'exe').removesuffix(' (deleted)')
            if proc.stat().st_uid == os.getuid() and Path(executable).name == 'agy':
                found.append(int(proc.name))
        except OSError:
            pass
    return found


def cli_active():
    result = subprocess.run(['systemctl', '--user', 'is-active', 'antigravity-cli-daemon.service'], text=True, capture_output=True, timeout=10)
    return result.stdout.strip() == 'active'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-profile', default='antigravity-ssh-preview')
    parser.add_argument('--target-profile', default='antigravity-cli')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    for name in (args.source_profile, args.target_profile):
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', name):
            parser.error('Use a profile directory name, not a path.')
    source = (Path.home() / '.gemini' / args.source_profile).resolve()
    target = (Path.home() / '.gemini' / args.target_profile).resolve()
    if source == target or not source.is_dir() or not target.is_dir():
        raise RuntimeError('The source and target profiles must be existing, different directories.')
    files = list(entries(source))
    plan = {
        'source': str(source), 'target': str(target),
        'sourceProcesses': source_processes(args.source_profile),
        'targetServiceRunning': cli_active(), 'targetCLIProcesses': cli_processes(), 'files': len(files),
        'sourceConversations': len(list((source / 'conversations').glob('*.db'))),
        'targetConversations': len(list((target / 'conversations').glob('*.db'))),
        'bytes': sum(path.stat().st_size for path in files if not path.is_symlink()),
        'parts': list(PARTS), 'sourcePreserved': True,
    }
    if not args.apply:
        print(json.dumps(plan))
        return
    if plan['sourceProcesses'] or plan['targetServiceRunning'] or plan['targetCLIProcesses']:
        raise RuntimeError('Finish the existing tasks and stop both backends before applying this migration. This tool never stops a backend.')
    run = Path.home() / '.config/gravrelay/migrations' / datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    run.mkdir(mode=0o700, parents=True)
    manifest = {**plan, 'files': {}, 'complete': False}
    report = run / 'manifest.json'
    report.write_text(json.dumps(manifest, indent=2))
    report.chmod(0o600)
    next_check = 0
    for index, path in enumerate(files, 1):
        if time.monotonic() >= next_check:
            if source_processes(args.source_profile) or cli_active() or cli_processes():
                raise RuntimeError('A backend restarted during migration. Original data and target backups are preserved.')
            next_check = time.monotonic() + 1
        relative = path.relative_to(source)
        parent = target
        for part in relative.parts[:-1]:
            parent = parent / part
            if parent.is_symlink():
                raise RuntimeError('A target parent directory is a symbolic link. No file was written through it.')
        manifest['files'][str(relative)] = copy_entry(path, target / relative, run / 'target-backup' / relative)
        if index % 100 == 0:
            report.write_text(json.dumps(manifest, indent=2))
    manifest['complete'] = True
    report.write_text(json.dumps(manifest, indent=2))
    print(json.dumps({'complete': True, 'filesVerified': len(manifest['files']), 'manifest': str(report), 'sourcePreserved': True}))


if __name__ == '__main__':
    main()

