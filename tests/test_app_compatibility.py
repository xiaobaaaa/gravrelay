import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('installer_compatibility',ROOT/'install.py')
installer=importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class ApplicationCompatibilityTests(unittest.TestCase):
    def test_reviewed_versions_still_require_the_original_google_signature(self):
        for version in ('2.29.0','2.31.0','2.31.2','2.32.1'):
            with patch.object(installer,'app_version',return_value=version), patch.object(
                    installer,'command',return_value=SimpleNamespace(returncode=0)) as command:
                installer.verify_app(Path('/fixture/Antigravity.app'))
                self.assertIn('--verify',command.call_args.args)
                self.assertIn('EQHXZ8M8AV',command.call_args.args[-2])

    def test_unreviewed_versions_are_rejected_without_touching_the_app(self):
        with patch.object(installer,'app_version',return_value='2.32.0'),patch.object(installer,'command') as command:
            with self.assertRaises(installer.InstallError):
                installer.verify_app(Path('/fixture/Antigravity.app'))
            command.assert_not_called()

    def test_supported_version_with_invalid_signature_is_rejected(self):
        with patch.object(installer,'app_version',return_value='2.31.0'),patch.object(
                installer,'command',return_value=SimpleNamespace(returncode=1)):
            with self.assertRaises(installer.InstallError):
                installer.verify_app(Path('/fixture/Antigravity.app'))

    def test_malformed_allowlist_cannot_enable_an_application_version(self):
        with patch.dict(installer.COMPATIBILITY, {'supportedAppVersions': '2.31.0'}), patch.object(
                installer, 'app_version', return_value='2.31.0'), patch.object(installer, 'command') as command:
            with self.assertRaises(installer.InstallError):
                installer.verify_app(Path('/fixture/Antigravity.app'))
            command.assert_not_called()
