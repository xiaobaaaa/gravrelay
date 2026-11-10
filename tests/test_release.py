import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


builder = load('release_builder', 'tools/build_release.py')
publisher = load('release_publisher', 'tools/publish_release.py')


class ReleaseFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'source'
        self.root.mkdir()
        self.output = Path(self.temp.name) / 'artifacts'
        (self.root / 'runtime').mkdir()
        (self.root / 'install.py').write_text("RELEASE = '1.2.3'\nRUNTIME = ('agent.cjs',)\n")
        (self.root / 'runtime/agent.cjs').write_text('console.log("fixture");\n')
        (self.root / 'install.sh').write_text('python3 install.py\n')
        (self.root / 'AGENTS_INSTALL.md').write_text('Install instructions\n')
        (self.root / 'README.md').write_text('git clone --branch v1.2.3 --depth 1 fixture\n')
        self.git('init', '-q')
        self.commit()
        self.git('tag', 'v1.2.3')

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args])

    def commit(self):
        self.git('add', '.')
        self.git('-c', 'user.name=Release test', '-c', 'user.email=test@example.invalid',
                 'commit', '-qm', 'Fixture source')

    def build(self, tag=None):
        with contextlib.redirect_stdout(io.StringIO()):
            return builder.build(self.root, self.output, tag)

class PackageTests(ReleaseFixture):
    def test_reproducible_archive_contains_only_committed_source_and_matching_hashes(self):
        (self.root / 'private-token.txt').write_text('untracked fixture; never package this')
        first = self.build('v1.2.3')
        archive = self.output / first['archive']
        expected_bytes = archive.read_bytes()
        self.assertEqual(self.build('v1.2.3'), first)
        self.assertEqual(archive.read_bytes(), expected_bytes)
        with zipfile.ZipFile(archive) as package:
            self.assertNotIn('gravrelay-v1.2.3/private-token.txt', package.namelist())
            for item in first['files']:
                data = package.read('gravrelay-v1.2.3/' + item['path'])
                self.assertEqual(hashlib.sha256(data).hexdigest(), item['sha256'])
        self.assertEqual(publisher.load_assets(self.output, 'v1.2.3', first['sourceCommit'])[archive.name],
                         hashlib.sha256(expected_bytes).hexdigest())

    def test_tag_mismatch_fails_before_writing_artifacts(self):
        with self.assertRaises(builder.PackageError):
            self.build('v9.9.9')
        self.assertFalse(self.output.exists())

    def test_uncommitted_changes_and_missing_runtime_cannot_be_released(self):
        runtime = self.root / 'runtime/agent.cjs'
        runtime.write_text('uncommitted change')
        with self.assertRaises(builder.PackageError):
            self.build()
        runtime.unlink()
        self.commit()
        with self.assertRaises(builder.PackageError):
            self.build()

    def test_runtime_symlinks_and_readme_version_prefixes_are_rejected(self):
        runtime = self.root / 'runtime/agent.cjs'
        runtime.unlink()
        runtime.symlink_to(self.root / 'README.md')
        self.commit()
        with self.assertRaises(builder.PackageError):
            self.build()
        runtime.unlink()
        runtime.write_text('fixture')
        (self.root / 'README.md').write_text('git clone --branch v1.2.30 fixture')
        self.commit()
        with self.assertRaises(builder.PackageError):
            self.build()


class FakeGitHub:
    def __init__(self, directory, commit, release=None):
        self.directory, self.commit, self.value = directory, commit, release
        self.operations = []

    def release(self, tag):
        return self.value

    def create(self, tag, commit):
        self.operations.append('create-draft')
        self.value = {'draft': True, 'target_commitish': commit, 'assets': []}

    def upload(self, tag, files):
        self.operations.append('upload')
        self.value['assets'].extend({'name': f.name, 'digest': 'sha256:' + publisher.sha256(f)}
                                    for f in files)

    def publish(self, tag):
        self.operations.append('publish')
        self.value['draft'] = False


class PublishTests(ReleaseFixture):
    def setUp(self):
        super().setUp()
        self.manifest = self.build()
        self.commit_id = self.manifest['sourceCommit']
        self.expected = publisher.load_assets(self.output, 'v1.2.3', self.commit_id)

    def publish(self, github):
        with contextlib.redirect_stdout(io.StringIO()):
            publisher.publish(self.output, 'v1.2.3', self.commit_id, github)

    def existing(self, draft=False):
        return {'draft': draft, 'target_commitish': self.commit_id,
                'assets': [{'name': k, 'digest': 'sha256:' + v} for k, v in self.expected.items()]}

    def test_new_release_is_verified_as_draft_before_it_becomes_public(self):
        github = FakeGitHub(self.output, self.commit_id)
        self.publish(github)
        self.assertEqual(github.operations, ['create-draft', 'upload', 'publish'])
        self.assertFalse(github.value['draft'])

    def test_rerun_of_identical_public_release_is_read_only(self):
        github = FakeGitHub(self.output, self.commit_id, self.existing())
        self.publish(github)
        self.assertEqual(github.operations, [])

    def test_draft_can_resume_but_published_assets_cannot_be_replaced(self):
        partial = self.existing(True)
        partial['assets'].pop()
        github = FakeGitHub(self.output, self.commit_id, partial)
        self.publish(github)
        self.assertEqual(github.operations, ['upload', 'publish'])
        mismatch = self.existing()
        mismatch['assets'][0]['digest'] = 'sha256:' + '0' * 64
        github = FakeGitHub(self.output, self.commit_id, mismatch)
        with self.assertRaises(publisher.PublishError):
            self.publish(github)
        self.assertEqual(github.operations, [])

    def test_artifact_tampering_or_wrong_commit_fails_before_remote_mutation(self):
        github = FakeGitHub(self.output, self.commit_id)
        with self.assertRaises(publisher.PublishError):
            publisher.load_assets(self.output, 'v1.2.3', 'different-source')
        (self.output / self.manifest['archive']).write_bytes(b'tampered')
        with self.assertRaises(publisher.PublishError):
            self.publish(github)
        self.assertEqual(github.operations, [])

    def test_wrong_existing_target_and_incomplete_public_release_are_not_changed(self):
        wrong = self.existing(True)
        wrong['target_commitish'] = 'different-source'
        incomplete = self.existing()
        incomplete['assets'].pop()
        for release in (wrong, incomplete):
            github = FakeGitHub(self.output, self.commit_id, release)
            with self.assertRaises(publisher.PublishError):
                self.publish(github)
            self.assertEqual(github.operations, [])

    def test_failed_upload_verification_keeps_the_release_private(self):
        class CorruptUpload(FakeGitHub):
            def upload(self, tag, files):
                super().upload(tag, files)
                self.value['assets'][-1]['digest'] = 'sha256:' + '0' * 64
        github = CorruptUpload(self.output, self.commit_id)
        with self.assertRaises(publisher.PublishError):
            self.publish(github)
        self.assertTrue(github.value['draft'])
        self.assertEqual(github.operations, ['create-draft', 'upload'])


class GitHubAdapterTests(unittest.TestCase):
    def test_draft_lookup_uses_the_draft_aware_cli_and_maps_fields(self):
        response = {'isDraft': True, 'targetCommitish': 'source-commit', 'assets': []}
        with patch.object(publisher.subprocess, 'run', return_value=SimpleNamespace(
                returncode=0, stdout=json.dumps(response), stderr='')) as run:
            release = publisher.GitHub('owner/repo').release('v1.2.3')
        self.assertEqual(release, {'draft': True, 'target_commitish': 'source-commit', 'assets': []})
        self.assertEqual(run.call_args.args[0][:4], ['gh', 'release', 'view', 'v1.2.3'])

    def test_missing_release_is_distinct_from_an_authentication_failure(self):
        github = publisher.GitHub('owner/repo')
        with patch.object(publisher.subprocess, 'run', return_value=SimpleNamespace(
                returncode=1, stdout='', stderr='release not found')):
            self.assertIsNone(github.release('v1.2.3'))
        with patch.object(publisher.subprocess, 'run', return_value=SimpleNamespace(
                returncode=1, stdout='', stderr='HTTP 403: access denied')):
            with self.assertRaises(publisher.PublishError):
                github.release('v1.2.3')
