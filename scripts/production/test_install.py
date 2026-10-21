"""Installer/installed-entrypoint tests; local temporary files and fake guards only."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("install_production", Path(__file__).with_name("install.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def git(source, *args):
    return subprocess.check_output(["git", "-C", str(source), *args], stderr=subprocess.DEVNULL, text=True).strip()


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        git(self.source, "init", "--quiet")
        git(self.source, "config", "user.name", "Test")
        git(self.source, "config", "user.email", "test@example.invalid")
        helper = self.source / installer.SOURCE_PATH
        helper.parent.mkdir(parents=True)
        helper.write_bytes(Path(__file__).with_name("deploy.py").read_bytes())
        git(self.source, "add", ".")
        git(self.source, "commit", "--quiet", "-m", "reviewed launcher")
        self.commit = git(self.source, "rev-parse", "HEAD")
        self.bin = self.root / "bin"
        self.state = self.root / "state"
        self.marker = self.root / "guard-ran"
        self.guard = self.root / "guard.py"
        self.guard.write_text("from pathlib import Path\nPath(" + repr(str(self.marker)) + ").write_text('ran')\n")
        self.manifest = self.root / "manifest.json"
        self.manifest.write_text(json.dumps({"schema": "paperclip.production-provenance.v1",
            "githubRepository": "https://github.com/missing/repository.git",
            "guard": {"path": str(self.guard), "sha256": installer.digest(self.guard.read_bytes())}}))

    def install(self):
        return installer.install(self.source, self.commit, self.bin, self.state)

    def invoke(self, *extra):
        return subprocess.run([sys.executable, str(self.bin / "paperclip-production-deploy"),
                               "--manifest", str(self.manifest), *extra], capture_output=True, text=True)

    def test_install_pins_source_and_never_runs_guard(self):
        receipt = self.install()
        self.assertEqual(receipt["sourceCommit"], self.commit)
        self.assertEqual(receipt["helperSha256"], installer.digest((self.source / installer.SOURCE_PATH).read_bytes()))
        self.assertEqual(receipt["productionMutations"], 0)
        self.assertFalse(self.marker.exists())
        self.assertEqual((self.state / "production-launcher-adoption.json").stat().st_mode & 0o777, 0o600)
        self.assertTrue(self.install()["helperSha256"] == receipt["helperSha256"])

    def test_installed_command_keeps_offline_rollback_and_explicit_execute(self):
        self.install()
        self.assertNotEqual(self.invoke("--phase", "rollback_restore").returncode, 0)
        self.assertFalse(self.marker.exists())
        self.assertEqual(self.invoke("--phase", "rollback_restore", "--execute").returncode, 0)
        self.assertTrue(self.marker.exists())

    def test_modified_pinned_helper_stops_before_guard(self):
        receipt = self.install()
        Path(receipt["helperPath"]).write_text("raise RuntimeError('changed')")
        result = self.invoke("--phase", "rollback_restore", "--execute")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Pinned production helper changed", result.stderr)
        self.assertFalse(self.marker.exists())

    def test_changed_guard_still_rejected_by_installed_command(self):
        self.install()
        self.guard.write_text("raise RuntimeError('changed guard')")
        self.assertNotEqual(self.invoke("--phase", "rollback_restore", "--execute").returncode, 0)
        self.assertFalse(self.marker.exists())

    def test_refuses_unrelated_or_modified_command(self):
        self.bin.mkdir()
        command = self.bin / "paperclip-production-deploy"
        command.write_text("unrelated")
        with self.assertRaises(ValueError):
            self.install()
        self.assertEqual(command.read_text(), "unrelated")
        command.unlink()
        self.install()
        command.write_text("modified launcher")
        with self.assertRaises(ValueError):
            self.install()
        self.assertEqual(command.read_text(), "modified launcher")

    def test_wrong_commit_and_dirty_checkout_are_rejected(self):
        original = self.commit
        self.commit = "f" * 40
        with self.assertRaises(ValueError):
            self.install()
        self.commit = original
        (self.source / installer.SOURCE_PATH).write_text("unreviewed")
        with self.assertRaises(ValueError):
            self.install()
        self.assertFalse(self.bin.exists())

    def test_update_pins_new_commit_and_helper(self):
        old = self.install()
        helper = self.source / installer.SOURCE_PATH
        helper.write_bytes(helper.read_bytes() + b"\n# reviewed update\n")
        git(self.source, "commit", "--quiet", "-am", "reviewed update")
        self.commit = git(self.source, "rev-parse", "HEAD")
        new = self.install()
        self.assertNotEqual(old["helperSha256"], new["helperSha256"])
        self.assertEqual(new["sourceCommit"], self.commit)
        self.assertEqual(self.invoke("--phase", "rollback_restore", "--execute").returncode, 0)

    def test_destination_symlinks_rejected(self):
        other = self.root / "other"
        other.mkdir()
        self.bin.symlink_to(other, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.install()
        self.assertFalse(list(other.iterdir()))


if __name__ == "__main__":
    unittest.main()
