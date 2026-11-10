#!/usr/bin/env python3
"""Build and verify a reproducible source ZIP from the clean Git HEAD."""
import argparse
import ast
import hashlib
import json
from pathlib import Path
import re
import stat
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]


class PackageError(RuntimeError):
    pass


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args])


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def metadata(root):
    values = {}
    for node in ast.parse((root / 'install.py').read_text()).body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id in ('RELEASE', 'RUNTIME'):
                    values[target.id] = ast.literal_eval(node.value)
    version = values.get('RELEASE', '')
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version):
        raise PackageError('The installer must declare a stable x.y.z RELEASE.')
    runtime = values.get('RUNTIME')
    if not isinstance(runtime, tuple) or not runtime or any(not isinstance(name, str) or
            Path(name).name != name for name in runtime):
        raise PackageError('The installer runtime inventory is invalid.')
    required = {'install.py', 'install.sh', 'README.md', 'AGENTS_INSTALL.md'}
    required.update('runtime/' + name for name in runtime)
    if not re.search(r'git clone --branch v' + re.escape(version) + r'(?:\s|$)', (root / 'README.md').read_text()):
        raise PackageError('The README release tag does not match the installer.')
    return version, required


def build(root, destination, tag=None):
    root, destination = Path(root).resolve(), Path(destination).resolve()
    if git(root, 'status', '--porcelain', '--untracked-files=no').strip():
        raise PackageError('Commit tracked changes before packaging Git HEAD.')
    version, required = metadata(root)
    expected_tag = 'v' + version
    if tag is not None and tag != expected_tag:
        raise PackageError('The pushed tag does not match install.py RELEASE.')
    commit = git(root, 'rev-parse', 'HEAD').decode().strip()
    if tag is not None and git(root, 'rev-list', '-n', '1', 'refs/tags/' + tag).decode().strip() != commit:
        raise PackageError('The release tag must resolve to the packaged Git HEAD.')
    files = git(root, 'ls-files', '-z').decode().rstrip('\0').split('\0')
    if not required.issubset(files):
        raise PackageError('A required installer/runtime file is not tracked.')
    for name in files:
        file = root / name
        if not file.is_file() or file.is_symlink():
            raise PackageError('Release source must contain only regular files: ' + name)
    destination.mkdir(parents=True, exist_ok=True)
    archive_name = 'gravrelay-' + expected_tag + '.zip'
    archive = destination / archive_name
    prefix = 'gravrelay-' + expected_tag + '/'
    subprocess.run(['git', '-C', str(root), 'archive', '--format=zip',
                    '--prefix=' + prefix, '-o', str(archive), 'HEAD'], check=True)
    entries = []
    with zipfile.ZipFile(archive) as package:
        actual = [item for item in package.infolist() if not item.is_dir()]
        if len({item.filename for item in actual}) != len(actual):
            raise PackageError('The ZIP contains duplicate file names.')
        if {item.filename for item in actual} != {prefix + name for name in files}:
            raise PackageError('The ZIP inventory does not match tracked source.')
        for item in actual:
            name = item.filename[len(prefix):]
            data = package.read(item)
            if data != (root / name).read_bytes():
                raise PackageError('Packaged bytes differ from source: ' + name)
            if stat.S_ISLNK(item.external_attr >> 16):
                raise PackageError('The ZIP contains a symbolic link.')
            entries.append({'path': name, 'size': len(data), 'sha256': sha256(data)})
        if metadata_from_zip(package, prefix) != version:
            raise PackageError('The packaged installer version differs from source.')
    manifest = {'schema': 1, 'version': version, 'tag': expected_tag, 'sourceCommit': commit,
                'archive': archive_name, 'archiveSHA256': sha256(archive.read_bytes()),
                'files': sorted(entries, key=lambda entry: entry['path'])}
    manifest_path = destination / 'release-manifest.json'
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + '\n')
    checksum_path = destination / 'SHA256SUMS'
    checksum_path.write_text(''.join(sha256(file.read_bytes()) + '  ' + file.name + '\n'
                                   for file in (archive, manifest_path)))
    print(json.dumps({key: manifest[key] for key in ('tag', 'sourceCommit', 'archiveSHA256')}))
    return manifest


def metadata_from_zip(package, prefix):
    for node in ast.parse(package.read(prefix + 'install.py').decode()).body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'RELEASE'
                                                for t in node.targets):
            return ast.literal_eval(node.value)
    raise PackageError('The packaged installer has no RELEASE.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'dist')
    parser.add_argument('--tag', help='Required exact version tag for an automatic release')
    args = parser.parse_args()
    build(ROOT, args.output_dir, args.tag)


if __name__ == '__main__':
    main()
