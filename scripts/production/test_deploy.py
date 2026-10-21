"""Offline integration tests: real Git remotes, fake guard that records dispatch."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("production_deploy", Path(__file__).with_name("deploy.py"))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


def git(*args):
    return subprocess.check_output(["git", *map(str, args)], stderr=subprocess.DEVNULL, text=True).strip()


class ProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        git("init", "--quiet", "--initial-branch=release", self.source)
        git("-C", self.source, "config", "user.name", "Test")
        git("-C", self.source, "config", "user.email", "test@example.invalid")
        (self.source / "source.txt").write_text("qualified source\n")
        git("-C", self.source, "add", ".")
        git("-C", self.source, "commit", "--quiet", "-m", "source")
        self.commit = git("-C", self.source, "rev-parse", "HEAD")
        self.tree = git("-C", self.source, "rev-parse", "HEAD^{tree}")
        self.remote = self.root / "remote.git"
        git("clone", "--quiet", "--bare", self.source, self.remote)
        self.marker = self.root / "guard-ran"
        self.guard = self.root / "guard.py"
        self.guard.write_text("from pathlib import Path\nPath(" + repr(str(self.marker)) + ").write_text('dispatched')\n")
        self.frame = {"candidateSourceCommit": self.commit, "candidateSourceTree": self.tree,
                      "sourceRepository": str(self.source), "candidateImageId": "sha256:" + "1" * 64}
        self.manifest = {"schema": "paperclip.production-provenance.v1", "githubRepository": str(self.remote),
                         "githubRef": "refs/heads/release", "guard": self.seal(self.guard)}
        self.manifest["candidateFrame"] = self.write("frame", self.frame)
        receipt = {"sourceCommit": self.commit, "sourceTree": self.tree,
                   "imageId": self.frame["candidateImageId"], "passed": True, "approved": True}
        self.manifest["testsReceipt"] = self.write("tests", receipt)
        self.manifest["reviewReceipt"] = self.write("review", receipt)
        self.path = self.root / "manifest.json"
        self.preparation = {"schema": "paperclip.codex-native.preparation.v1",
                            "helperSha256": self.manifest["guard"]["sha256"],
                            "framePath": self.manifest["candidateFrame"]["path"],
                            "frameSha256": self.manifest["candidateFrame"]["sha256"]}
        (self.root / "preparation.json").write_text(json.dumps(self.preparation))

    def seal(self, path):
        return {"path": str(path), "sha256": deploy.sha256(path)}

    def write(self, name, obj):
        path = self.root / (name + ".json")
        path.write_text(json.dumps(obj))
        return self.seal(path)

    def run_gate(self, phase=None, execute=False):
        self.path.write_text(json.dumps(self.manifest))
        return deploy.run(self.path, phase, execute, allow_local_remote=True)

    def rejects(self):
        with self.assertRaises((ValueError, KeyError)):
            self.run_gate("apply", True)
        self.assertFalse(self.marker.exists(), "guard must not run before provenance passes")

    def test_preflight_is_read_only_then_apply_is_gated(self):
        self.assertTrue(self.run_gate()["passed"])
        self.assertFalse(self.marker.exists())
        self.assertTrue(self.run_gate("apply", True)["guardCompleted"])
        self.assertTrue(self.marker.exists())

    def test_every_supported_phase_passes_through_gate(self):
        self.manifest["githubRef"] = "refs/heads/missing"
        for phase in (p for p in deploy.ACTIONS if p not in deploy.ROLLBACK_ACTIONS):
            with self.subTest(phase=phase), self.assertRaises(ValueError):
                self.run_gate(phase, True)
        self.assertFalse(self.marker.exists())

    def test_verified_rollback_guard_is_reachable_without_github_or_candidate(self):
        self.manifest["githubRepository"] = "https://github.com/missing/repository.git"
        self.manifest.pop("candidateFrame")
        self.manifest.pop("testsReceipt")
        self.manifest.pop("reviewReceipt")
        for phase in deploy.ROLLBACK_ACTIONS:
            with self.subTest(phase=phase):
                result = self.run_gate(phase, True)
                self.assertFalse(result["githubContacted"])
                self.assertTrue(self.marker.exists())
                self.marker.unlink()
        # The offline rollback path still requires the exact selected guard.
        self.guard.write_text("raise RuntimeError('unreviewed guard')")
        self.rejects_rollback()

    def rejects_rollback(self):
        with self.assertRaises(ValueError):
            self.run_gate("rollback_restore", True)
        self.assertFalse(self.marker.exists())

    def test_explicit_execute_required(self):
        with self.assertRaises(ValueError):
            self.run_gate("drain")
        self.assertFalse(self.marker.exists())

    def test_missing_remote(self):
        self.manifest["githubRepository"] = str(self.root / "absent.git")
        self.rejects()

    def test_mismatched_remote_commit(self):
        (self.source / "source.txt").write_text("new source\n")
        git("-C", self.source, "commit", "--quiet", "-am", "new source")
        git("-C", self.source, "push", "--quiet", self.remote, "HEAD:refs/heads/release")
        git("-C", self.source, "checkout", "--quiet", self.commit)
        self.rejects()

    def test_dirty_and_untracked_checkout(self):
        for filename in ("source.txt", "untracked.txt"):
            with self.subTest(filename=filename):
                (self.source / filename).write_text("unqualified")
                self.rejects()
                git("-C", self.source, "checkout", "--", "source.txt")
                (self.source / "untracked.txt").unlink(missing_ok=True)

    def test_hidden_tracked_modifications_rejected(self):
        for flag, undo in (("--assume-unchanged", "--no-assume-unchanged"),
                           ("--skip-worktree", "--no-skip-worktree")):
            with self.subTest(flag=flag):
                git("-C", self.source, "update-index", flag, "source.txt")
                (self.source / "source.txt").write_text("hidden unqualified modification")
                self.assertEqual(git("-C", self.source, "status", "--porcelain"), "")
                self.rejects()
                git("-C", self.source, "update-index", undo, "source.txt")
                git("-C", self.source, "checkout", "--", "source.txt")

    def test_wrong_candidate_tree(self):
        self.frame["candidateSourceTree"] = "f" * 40
        self.manifest["candidateFrame"] = self.write("frame", self.frame)
        self.rejects()

    def test_receipts_bound_to_source_image_and_success(self):
        for role in ("tests", "review"):
            original = json.loads(Path(self.manifest[role + "Receipt"]["path"]).read_text())
            for key, bad in (("sourceCommit", "f" * 40), ("sourceTree", "f" * 40),
                             ("imageId", "sha256:" + "2" * 64), ("passed", False)):
                with self.subTest(role=role, key=key):
                    changed = {**original, key: bad}
                    self.manifest[role + "Receipt"] = self.write(role, changed)
                    self.rejects()
            self.manifest[role + "Receipt"] = self.write(role, original)
        original["approved"] = False
        self.manifest["reviewReceipt"] = self.write("review", original)
        self.rejects()

    def test_changed_sealed_guard_and_receipts(self):
        for key in ("candidateFrame", "testsReceipt", "reviewReceipt", "guard"):
            path = Path(self.manifest[key]["path"])
            original = path.read_bytes()
            with self.subTest(key=key):
                path.write_bytes(original + b"\n")
                self.rejects()
                path.write_bytes(original)

    def test_other_prepared_candidate_never_dispatches(self):
        other = self.write("other-frame", {**self.frame, "candidateImageId": "sha256:" + "2" * 64})
        (self.root / "preparation.json").write_text(json.dumps({
            "schema": "paperclip.codex-native.preparation.v1",
            "helperSha256": self.manifest["guard"]["sha256"],
            "framePath": other["path"], "frameSha256": other["sha256"],
        }))
        for phase in (p for p in deploy.ACTIONS if p != "prepare" and p not in deploy.ROLLBACK_ACTIONS):
            with self.subTest(phase=phase), self.assertRaises(ValueError):
                self.run_gate(phase, True)
        self.assertFalse(self.marker.exists(), "a different prepared release must never dispatch")

    def test_missing_unknown_and_changed_preparation_refused(self):
        path = self.root / "preparation.json"
        path.unlink()
        with self.assertRaises(OSError):
            self.run_gate("apply", True)
        for key, bad in (("schema", "unknown"), ("helperSha256", "0" * 64),
                         ("frameSha256", "0" * 64), ("framePath", "relative.json")):
            with self.subTest(key=key):
                path.write_text(json.dumps({**self.preparation, key: bad}))
                self.rejects()
        self.assertFalse(self.marker.exists())

    def test_prepare_does_not_require_an_existing_preparation(self):
        (self.root / "preparation.json").unlink()
        self.assertTrue(self.run_gate("prepare", True)["guardCompleted"])

    def test_preparation_change_during_proof_never_dispatches(self):
        from unittest.mock import patch
        verify = deploy.verify
        def change_after_proof(*args, **kwargs):
            proof = verify(*args, **kwargs)
            path = self.root / "preparation.json"
            path.write_bytes(path.read_bytes() + b"\n")
            return proof
        with patch.object(deploy, "verify", side_effect=change_after_proof), self.assertRaises(ValueError):
            self.run_gate("apply", True)
        self.assertFalse(self.marker.exists())

    def test_public_cli_cannot_use_local_remotes(self):
        with self.assertRaises(ValueError):
            deploy.verify(self.manifest)

    def test_annotated_remote_tag(self):
        git("-C", self.source, "tag", "-a", "release-test", "-m", "release")
        git("-C", self.source, "push", "--quiet", self.remote, "refs/tags/release-test")
        self.manifest["githubRef"] = "refs/tags/release-test"
        self.assertTrue(self.run_gate()["passed"])


if __name__ == "__main__":
    unittest.main()
