#!/usr/bin/env python3
"""Real Linux bind-mount/ownership regressions; never mounts production data."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import time
import unittest
from unittest import mock


parser = argparse.ArgumentParser(add_help=False)
parser.add_argument("--image", required=True, help="An explicitly built or selected image with the Dockerfile base runtime tools")
parser.add_argument("--entrypoint", type=Path, default=Path(__file__).resolve().parents[1] / "docker-entrypoint.sh")
ARGS, TEST_ARGS = parser.parse_known_args()


class OwnershipIntegration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="paperclip-ownership-")
        self.root = Path(self.temp.name)
        self.home = self.directory("home")
        self.observed = self.directory("observed")
        self.bin = self.directory("bin")
        # Record real find dispatch, then use its actual traversal and chown.
        (self.bin / "find").write_text(
            '#!/usr/bin/python3\nimport os, pathlib, sys\n'
            'observed = pathlib.Path("/observed")\n'
            'with (observed / "find-roots").open("ab") as log: log.write(os.fsencode(sys.argv[1]) + b"\\0")\n'
            '(observed / "find-pid").write_text(str(os.getpid()))\n'
            '(observed / "find-signal-mask").write_text(next(line for line in pathlib.Path("/proc/self/status").read_text().splitlines() if line.startswith("SigBlk:")))\n'
            'os.execv("/usr/bin/find", ["find", *sys.argv[1:]])\n'
        )
        (self.bin / "find").chmod(0o755)
        (self.bin / "chown").write_text(
            '#!/bin/sh\nif [ -f /observed/delay-chown ]; then\n'
            '  touch /observed/chown-started\n  sleep 16\nfi\nexec /usr/bin/chown "$@"\n'
        )
        (self.bin / "chown").chmod(0o755)

    def tearDown(self):
        subprocess.run(["docker", "run", "--rm", "--network", "none", "--entrypoint", "/bin/chown",
                        "--mount", f"type=bind,src={self.root},dst=/fixture", ARGS.image,
                        "-hR", "1000:1000", "/fixture"], check=True, capture_output=True, timeout=20)
        self.temp.cleanup()

    def directory(self, name):
        path = self.root / name
        path.mkdir(parents=True)
        path.chmod(0o755)
        return path

    def execute(self, mounts=(), command="id -u; id -g", env=(), setup="true", home_readonly=False,
                mount_capability=False, drop_chown=False):
        args = ["docker", "run", "--rm", "--network", "none", "--label", "task=paperclip-ownership-test",
                "--entrypoint", "/bin/sh", "--tmpfs", "/tmp:rw,nosuid,size=16m",
                "--env", "PAPERCLIP_HOME=/test-home", "--env", "PATH=/test-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"]
        if mount_capability:
            args += ["--cap-add", "SYS_ADMIN", "--security-opt", "apparmor=unconfined"]
        if drop_chown:
            args += ["--cap-drop", "CHOWN"]
        bindings = [(self.home, "/test-home", home_readonly), (self.observed, "/observed", False),
                    (self.bin, "/test-bin", True), (ARGS.entrypoint, "/test-entrypoint.sh", True)]
        helper = ARGS.entrypoint.with_name("docker-ownership-repair.py")
        if helper.exists():
            bindings.append((helper, "/docker-ownership-repair.py", True))
        for source, target, readonly in [*bindings, *mounts]:
            spec = f"type=bind,src={source},dst={target}" + (",readonly" if readonly else "")
            args += ["--mount", spec]
        for key, value in env:
            args += ["--env", f"{key}={value}"]
        args += [ARGS.image, "-c", setup + '\nexec /bin/sh /test-entrypoint.sh /bin/sh -c "$1"', "ownership-test", command]
        result = subprocess.run(args, capture_output=True, text=True, timeout=30)
        roots_file = self.observed / "find-roots"
        roots = roots_file.read_bytes().decode().strip("\0").split("\0") if roots_file.exists() else []
        return result, roots

    def assert_success(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_equivalent_aliases_are_traversed_once(self):
        shared = self.directory("shared")
        (shared / "restored-file").write_text("synthetic")
        result, roots = self.execute([(shared, "/test-home/a", False), (shared, "/test-home/b", False)],
                                     setup="chown -R 0:0 /test-home/a")
        self.assert_success(result)
        self.assertEqual(len([p for p in roots if p in ["/test-home/a", "/test-home/b"]]), 1, roots)
        self.assertIn('"event":"ownership_complete"', result.stderr)

    def test_different_nested_views_remain_separate_and_readonly_is_untouched(self):
        shared = self.directory("shared")
        (shared / "protected").mkdir()
        (shared / "protected" / "ordinary").write_text("synthetic")
        protected = self.directory("protected")
        (protected / "credential-canary").write_text("synthetic-private-canary")
        mounts = [(shared, "/test-home/a", False), (shared, "/test-home/b", False),
                  (protected, "/test-home/a/protected", True),
                  (shared, "/seed-shared", False), (protected, "/seed-protected", False)]
        result, roots = self.execute(mounts,
                                     setup="chown -R 0:0 /seed-shared; chown -R 1234:1234 /seed-protected",
                                     command="stat -c '%u:%g' /test-home/b/protected/ordinary; stat -c '%u:%g' /test-home/a/protected/credential-canary")
        self.assert_success(result)
        self.assertIn("/test-home/a", roots)
        self.assertIn("/test-home/b", roots)
        self.assertEqual(result.stdout.splitlines(), ["1000:1000", "1234:1234"])

    def test_literal_mount_names_and_symlinks_do_not_escape_repair(self):
        shared = self.directory("shared")
        (shared / "canary").write_text("synthetic")
        target = "/test-home/space [literal]*?\ttab\\slash"
        result, _ = self.execute([(shared, target, True), (shared, "/seed-shared", False)],
                                setup="chown -R 1234:1234 /seed-shared",
                                command=f"test -r {shlex.quote(target + '/canary')}")
        self.assert_success(result)
        self.assertNotIn("synthetic", result.stderr)

    def test_parent_view_covers_sibling_subtree_alias(self):
        shared = self.directory("shared")
        child = shared / "child"
        child.mkdir()
        (child / "restored-file").write_text("synthetic")
        result, roots = self.execute([(shared, "/test-home/parent", False), (child, "/test-home/alias", False)],
                                     setup="chown -R 0:0 /test-home/parent",
                                     command="stat -c '%u:%g' /test-home/alias/restored-file")
        self.assert_success(result)
        self.assertIn("/test-home/parent", roots)
        self.assertNotIn("/test-home/alias", roots)
        self.assertEqual(result.stdout.strip(), "1000:1000")

    def test_gid_only_remap_repairs_descendants_with_correct_root_owner(self):
        (self.home / "restored-file").write_text("synthetic")
        result, _ = self.execute(env=[("USER_GID", "1001")],
                                 setup="chown 1000:1001 /test-home; chown 1000:0 /test-home/restored-file",
                                 command="id -u; id -g; stat -c '%u:%g' /test-home/restored-file")
        self.assert_success(result)
        self.assertEqual(result.stdout.splitlines()[-3:], ["1000", "1001", "1000:1001"])

    def test_symlink_targets_outside_home_remain_untouched(self):
        outside = self.directory("outside")
        (outside / "target").write_text("synthetic")
        (self.home / "link").symlink_to("/outside/target")
        (self.home / "broken-link").symlink_to("/outside/missing")
        result, _ = self.execute([(outside, "/outside", False)],
                                 setup="chown 1234:1234 /outside/target; chown -h 0:0 /test-home/link /test-home/broken-link",
                                 command="stat -c '%u:%g' /outside/target /test-home/link /test-home/broken-link")
        self.assert_success(result)
        self.assertEqual(result.stdout.splitlines(), ["1234:1234", "1000:1000", "1000:1000"])

    def test_readonly_home_keeps_writable_nested_mount_repair(self):
        shared = self.directory("shared")
        (self.home / "writable").mkdir()
        (self.home / "credential-canary").write_text("synthetic")
        (shared / "restored-file").write_text("synthetic")
        result, roots = self.execute([(shared, "/test-home/writable", False),
                                     (self.home, "/seed-home", False)], home_readonly=True,
                                     setup="chown 1234:1234 /seed-home/credential-canary; chown -R 0:0 /test-home/writable",
                                     command="stat -c '%u:%g' /test-home/credential-canary /test-home/writable/restored-file")
        self.assert_success(result)
        self.assertNotIn("/test-home", roots)
        self.assertIn("/test-home/writable", roots)
        self.assertEqual(result.stdout.splitlines(), ["1234:1234", "1000:1000"])

    def test_stacked_mount_metadata_fails_closed(self):
        old = self.directory("old")
        new = self.directory("new")
        (new / "untouched").write_text("synthetic")
        result, roots = self.execute([(old, "/test-home/stacked", False), (new, "/new-view", False)],
                                     mount_capability=True,
                                     setup="chown -R 0:0 /new-view; mount --bind /new-view /test-home/stacked || exit 90",
                                     command="echo SHOULD-NOT-RUN")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotEqual(result.returncode, 90, result.stderr)
        self.assertIn('"event":"ownership_phase_failed"', result.stderr)
        self.assertNotIn("SHOULD-NOT-RUN", result.stdout)
        self.assertEqual(roots, [])

    def test_hidden_nested_mount_cannot_prune_visible_backing_entries(self):
        protected = self.directory("protected")
        visible = self.directory("visible")
        (visible / "child").mkdir()
        (visible / "child" / "restored-file").write_text("synthetic")
        result, roots = self.execute([(protected, "/test-home/parent/child", True),
                                  (visible, "/visible-view", False)], mount_capability=True,
                                 setup="chown -R 0:0 /visible-view; mount --bind /visible-view /test-home/parent || exit 90",
                                 command="stat -c '%u:%g' /test-home/parent/child/restored-file")
        self.assertNotEqual(result.returncode, 90, result.stderr)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('"event":"ownership_phase_failed"', result.stderr)
        self.assertEqual(result.stdout.strip(), "")
        self.assertEqual(roots, [])

    def test_readonly_alias_never_covers_a_writable_view(self):
        shared = self.directory("shared")
        (shared / "restored-file").write_text("synthetic")
        result, roots = self.execute([(shared, "/test-home/0-readonly", True),
                                     (shared, "/test-home/1-writable", False),
                                     (shared, "/seed-shared", False)],
                                     setup="chown -R 0:0 /seed-shared",
                                     command="stat -c '%u:%g' /test-home/1-writable/restored-file")
        self.assert_success(result)
        self.assertNotIn("/test-home/0-readonly", roots)
        self.assertIn("/test-home/1-writable", roots)
        self.assertEqual(result.stdout.strip(), "1000:1000")

    def test_same_device_different_backing_roots_are_both_repaired(self):
        left, right = self.directory("left"), self.directory("right")
        for directory in [left, right]:
            (directory / "restored-file").write_text("synthetic")
        result, roots = self.execute([(left, "/test-home/a", False), (right, "/test-home/b", False)],
                                     setup="chown -R 0:0 /test-home/a /test-home/b",
                                     command="stat -c '%u:%g' /test-home/a/restored-file /test-home/b/restored-file")
        self.assert_success(result)
        self.assertIn("/test-home/a", roots)
        self.assertIn("/test-home/b", roots)
        self.assertEqual(result.stdout.splitlines(), ["1000:1000", "1000:1000"])

    def test_special_custom_home_remains_a_literal_path(self):
        name = "-leading [home]*?"
        directory = self.home / name
        directory.mkdir()
        (directory / "restored-file").write_text("synthetic")
        target = "/test-home/" + name
        result, _ = self.execute(env=[("PAPERCLIP_HOME", target)],
                                 setup=f"chown -R 0:0 {shlex.quote(target)}",
                                 command=f"stat -c '%u:%g' {shlex.quote(target + '/restored-file')}")
        self.assert_success(result)
        self.assertEqual(result.stdout.strip(), "1000:1000")

    def test_long_scan_reports_progress_and_never_logs_descendant_names(self):
        (self.observed / "delay-chown").touch()
        (self.home / "private-descendant-canary").write_text("synthetic-private-value")
        result, _ = self.execute(setup="/usr/bin/chown 0:0 /test-home")
        self.assert_success(result)
        events = [json.loads(line) for line in result.stderr.splitlines()]
        self.assertIn("ownership_progress", [event["event"] for event in events])
        self.assertEqual(events[-1]["event"], "ownership_phase_complete")
        self.assertNotIn("private-descendant-canary", result.stderr)
        self.assertNotIn("synthetic-private-value", result.stderr)

    def test_signals_during_scan_prevent_app_launch_and_promptly_reap_find(self):
        (self.observed / "delay-chown").touch()
        for name, exit_code in [("TERM", 143), ("INT", 130)]:
            with self.subTest(signal=name):
                started = time.monotonic()
                result, _ = self.execute(setup=f"/usr/bin/chown 0:0 /test-home; (sleep 1; kill -{name} 1) &",
                                         command="echo SHOULD-NOT-RUN")
                elapsed = time.monotonic() - started
                self.assertTrue((self.observed / "chown-started").exists())
                mask = int((self.observed / "find-signal-mask").read_text().split()[-1], 16)
                self.assertEqual(mask & ((1 << 14) | (1 << 1)), 0, f"find inherited blocked TERM/INT: {mask:x}")
                self.assertEqual(result.returncode, exit_code, result.stderr)
                self.assertLess(elapsed, 5, f"signal escalation delayed {elapsed:.1f}s")
                self.assertNotIn("SHOULD-NOT-RUN", result.stdout)
                self.assertNotIn('"event":"ownership_phase_complete"', result.stderr)

    def test_signal_at_spawn_boundary_reaps_child_before_helper_exit(self):
        (self.observed / "delay-chown").touch()
        # Intercept only the real find launch, after Popen creates the child but
        # before repair can register it. This makes the cancellation race exact.
        launcher = self.bin / "python3"
        launcher.write_text("""#!/usr/bin/python3
import importlib.util, json, os, pathlib, signal, subprocess, sys, time
observed = pathlib.Path('/observed')
spec = importlib.util.spec_from_file_location('ownership', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
sys.argv = sys.argv[1:]
original = subprocess.Popen
proof = {}
def launch(command, *args, **kwargs):
    child = original(command, *args, **kwargs)
    if command[0] == 'find':
        deadline = time.monotonic() + 2
        while not (observed / 'chown-started').exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        proof.update(registrationPending=module.active_scan is None, childAlive=child.poll() is None)
        os.kill(os.getpid(), signal.SIGTERM)
    return child
subprocess.Popen = launch
signal.signal(signal.SIGTERM, module.stop)
signal.signal(signal.SIGINT, module.stop)
try:
    module.main()
except SystemExit:
    proof['childReapedBeforeExit'] = module.active_scan is not None and module.active_scan.returncode is not None
    (observed / 'launch-proof.json').write_text(json.dumps(proof))
    raise
""")
        launcher.chmod(0o755)
        started = time.monotonic()
        result, _ = self.execute(setup="/usr/bin/chown 0:0 /test-home", command="echo SHOULD-NOT-RUN")
        self.assertEqual(result.returncode, 143, result.stderr)
        self.assertLess(time.monotonic() - started, 5)
        self.assertTrue((self.observed / "chown-started").exists())
        self.assertEqual(json.loads((self.observed / "launch-proof.json").read_text()), {
            "registrationPending": True, "childAlive": True, "childReapedBeforeExit": True,
        })
        self.assertNotIn("SHOULD-NOT-RUN", result.stdout)

    def test_failed_real_chown_prevents_app_launch(self):
        (self.home / "restored-file").write_text("synthetic")
        subprocess.run(["docker", "run", "--rm", "--network", "none", "--entrypoint", "/bin/chown",
                        "--mount", f"type=bind,src={self.home},dst=/fixture", ARGS.image,
                        "0:0", "/fixture/restored-file"], check=True, capture_output=True, timeout=20)
        result, _ = self.execute(drop_chown=True, command="echo SHOULD-NOT-RUN")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('"event":"ownership_failed"', result.stderr)
        self.assertNotIn("SHOULD-NOT-RUN", result.stdout)


class OwnershipCancellation(unittest.TestCase):
    def test_child_exit_during_kill_escalation_is_reaped(self):
        helper = ARGS.entrypoint.with_name("docker-ownership-repair.py")
        spec = importlib.util.spec_from_file_location("ownership", helper)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        child = mock.Mock(pid=12345)
        child.wait.side_effect = [subprocess.TimeoutExpired("ownership scan", 10), 0]
        module.active_scan = child
        # The process can exit after wait times out but before escalation.
        with mock.patch.object(module.os, "killpg", side_effect=[None, ProcessLookupError]):
            with self.assertRaises(SystemExit) as stopped:
                module.stop(15, None)
        self.assertEqual(stopped.exception.code, 143)
        self.assertEqual(child.wait.call_count, 2)


if __name__ == "__main__":
    unittest.main(argv=[__file__, *TEST_ARGS], verbosity=2)
