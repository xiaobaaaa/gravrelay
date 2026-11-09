import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('migration', Path(__file__).resolve().parents[1] / 'tools/migrate_legacy.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MigrationTests(unittest.TestCase):
    def test_preserves_committed_rows_that_are_still_in_sqlite_wal(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            source, target = root / 'source.db', root / 'target.db'
            original = sqlite3.connect(source)
            try:
                original.execute('PRAGMA journal_mode=WAL')
                original.execute('CREATE TABLE messages(id INTEGER PRIMARY KEY, body TEXT)')
                original.execute('INSERT INTO messages(body) VALUES (?)', ('committed in WAL',))
                original.commit()
                self.assertGreater(Path(str(source) + '-wal').stat().st_size, 0)
                result = module.copy_entry(source, target, root / 'backup.db')
                with sqlite3.connect(target) as copied:
                    self.assertEqual(copied.execute('SELECT body FROM messages').fetchall(), [('committed in WAL',)])
                    self.assertEqual(copied.execute('PRAGMA quick_check').fetchone()[0], 'ok')
                self.assertEqual(result['method'], 'sqlite_backup')
            finally:
                original.close()

    def test_backs_up_existing_target_and_keeps_source_independent(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            source, target, backup = root / 'source.bin', root / 'target.bin', root / 'backup/target.bin'
            source.write_bytes(b'original conversation')
            target.write_bytes(b'previous target contents')
            result = module.copy_entry(source, target, backup)
            self.assertEqual(target.read_bytes(), source.read_bytes())
            self.assertEqual(backup.read_bytes(), b'previous target contents')
            self.assertEqual(source.read_bytes(), b'original conversation')
            self.assertFalse(source.samefile(target))
            self.assertEqual(result['sourceSHA256'], result['targetSHA256'])


if __name__ == '__main__':
    unittest.main()

