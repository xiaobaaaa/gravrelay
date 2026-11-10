#!/usr/bin/env python3
"""Publish verified assets as a draft first; never overwrite a published asset."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess


class PublishError(RuntimeError):
    pass


def sha256(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def load_assets(directory, tag, commit):
    manifest_file = directory / 'release-manifest.json'
    manifest = json.loads(manifest_file.read_text())
    if manifest.get('tag') != tag or manifest.get('sourceCommit') != commit:
        raise PublishError('The artifact does not match the checked-out tag and commit.')
    archive = 'gravrelay-' + tag + '.zip'
    if manifest.get('archive') != archive or manifest.get('archiveSHA256') != sha256(directory / archive):
        raise PublishError('The archive checksum does not match the manifest.')
    checksums = directory / 'SHA256SUMS'
    expected = {archive: sha256(directory / archive), manifest_file.name: sha256(manifest_file)}
    if checksums.read_text() != ''.join(value + '  ' + name + '\n' for name, value in expected.items()):
        raise PublishError('SHA256SUMS does not match the package files.')
    return {**expected, checksums.name: sha256(checksums)}


class GitHub:
    def __init__(self, repo):
        self.repo = repo

    def command(self, *args):
        result = subprocess.run(['gh', *args], capture_output=True, text=True)
        if result.returncode:
            raise PublishError(result.stderr.strip() or 'GitHub CLI request failed.')
        return result.stdout

    def release(self, tag):
        result = subprocess.run(['gh', 'api', 'repos/' + self.repo + '/releases/tags/' + tag],
                                capture_output=True, text=True)
        if result.returncode and 'HTTP 404' in result.stderr:
            return None
        if result.returncode:
            raise PublishError(result.stderr.strip() or 'Cannot query the release.')
        return json.loads(result.stdout)

    def create(self, tag, commit):
        self.command('release', 'create', tag, '--repo', self.repo, '--verify-tag', '--draft',
                     '--target', commit, '--title', 'GravRelay ' + tag, '--generate-notes')

    def upload(self, tag, files):
        self.command('release', 'upload', tag, *map(str, files), '--repo', self.repo)

    def publish(self, tag):
        self.command('release', 'edit', tag, '--repo', self.repo, '--draft=false', '--latest')


def publish(directory, tag, commit, github):
    if not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+', tag):
        raise PublishError('Invalid stable release tag.')
    expected = load_assets(directory, tag, commit)
    release = github.release(tag)
    if release is None:
        github.create(tag, commit)
        release = github.release(tag)
    if release is None or release.get('target_commitish') != commit:
        raise PublishError('The release target does not match the artifact source commit.')
    assets = {asset['name']: asset for asset in release.get('assets', [])}
    for name, digest in expected.items():
        if name in assets and assets[name].get('digest') != 'sha256:' + digest:
            raise PublishError('Existing release asset differs; it will not be overwritten: ' + name)
    missing = [directory / name for name in expected if name not in assets]
    if not release.get('draft') and missing:
        raise PublishError('Published release is incomplete; refusing to mutate it.')
    if missing:
        github.upload(tag, missing)
    release = github.release(tag)
    assets = {asset['name']: asset for asset in release.get('assets', [])}
    if any(assets.get(name, {}).get('digest') != 'sha256:' + digest for name, digest in expected.items()):
        raise PublishError('Uploaded asset verification failed; the release remains a draft.')
    if release.get('draft'):
        github.publish(tag)
    print('Verified public release: ' + tag)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--repo', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repo):
        raise PublishError('Invalid GitHub repository name.')
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
    tagged = subprocess.check_output(['git', 'rev-list', '-n', '1', 'refs/tags/' + args.tag], text=True).strip()
    if tagged != commit:
        raise PublishError('The checked-out commit does not match the pushed tag.')
    publish(args.directory.resolve(), args.tag, commit, GitHub(args.repo))


if __name__ == '__main__':
    main()
