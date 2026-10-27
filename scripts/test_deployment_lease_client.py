import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
import fcntl

SPEC = importlib.util.spec_from_file_location("deployment_lease_client", Path(__file__).with_name("deployment-lease-client.py"))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name)
        self.path.chmod(0o700)
        self.boot = "11111111-1111-4111-8111-111111111111"
        self.token = "a" * 64
        self.generation = 0
        self.calls = []
        self.draining = False
        self.owned = False

    def tearDown(self):
        self.temp.cleanup()

    def call(self, method, path, body):
        self.calls.append((method, path, body))
        if method != "GET":
            self.generation += 1
            if path == "/api/instance/deployment-lease":
                self.owned = method != "DELETE"
            if path == "/api/instance/task-drain":
                self.draining = method == "POST"
        public = {"generation": self.generation, "bootId": self.boot, "ownerBootId": self.boot if self.owned else None,
                  "owned": self.owned, "expired": False, "draining": self.draining}
        if path == "/api/instance/task-drain":
            return 200, {"deploymentLease": public}
        if method == "POST" and path == "/api/instance/deployment-lease":
            public["ownerToken"] = self.token
        return 200, public

    def test_capability_is_private_and_each_operation_keeps_an_exclusive_receipt(self):
        with MODULE.DeploymentLeaseClient(self.call, self.path) as client:
            for op in ["acquire", "drain", "clear-drain", "release"]:
                result = client.mutate(op, expected_boot_id=self.boot, expected_generation=0 if op == "acquire" else None,
                                       ttl_ms=60000 if op == "acquire" else None)
                self.assertNotIn(self.token, json.dumps(result))
            self.assertFalse(client.status()["owned"])
        self.assertEqual(len(list(self.path.glob("receipt-*.json"))), 4)
        self.assertEqual(len(list(self.path.glob("intent-*.json"))), 4)
        for p in self.path.iterdir():
            self.assertEqual(p.stat().st_mode & 0o777, 0o600)
        for p in list(self.path.glob("receipt-*.json")) + list(self.path.glob("intent-*.json")):
            self.assertNotIn(self.token, p.read_text())

    def test_unknown_network_result_blocks_replay_without_printing_exception(self):
        def failed(*_args):
            raise RuntimeError(self.token)
        with MODULE.DeploymentLeaseClient(failed, self.path) as client:
            with self.assertRaises(MODULE.LeaseClientError) as error:
                client.mutate("acquire", expected_boot_id=self.boot, expected_generation=0, ttl_ms=60000)
            self.assertNotIn(self.token, str(error.exception))
            self.assertTrue((self.path / "pending.json").is_file())
            client.call = self.call
            with self.assertRaisesRegex(MODULE.LeaseClientError, "unreconciled"):
                client.mutate("acquire", expected_boot_id=self.boot, expected_generation=0, ttl_ms=60000)
            self.assertEqual(self.calls, [])

    def test_mismatched_success_response_cannot_advance_local_owner(self):
        with MODULE.DeploymentLeaseClient(self.call, self.path) as client:
            client.mutate("acquire", expected_boot_id=self.boot, expected_generation=0, ttl_ms=60000)
            current = (self.path / "current.json").read_bytes()
            client.call = lambda *_args: (200, {"generation": 99, "bootId": self.boot})
            with self.assertRaisesRegex(MODULE.LeaseClientError, "response mismatch"):
                client.mutate("renew", expected_boot_id=self.boot, ttl_ms=60000)
            self.assertEqual((self.path / "current.json").read_bytes(), current)

    def test_rejects_symlink_state_or_shared_directory(self):
        self.path.chmod(0o755)
        with self.assertRaises(MODULE.LeaseClientError):
            MODULE.DeploymentLeaseClient(self.call, self.path)
        self.path.chmod(0o700)
        target = self.path / "target.json"
        target.write_text("{}")
        target.chmod(0o600)
        (self.path / "current.json").symlink_to(target)
        with MODULE.DeploymentLeaseClient(self.call, self.path) as client:
            with self.assertRaises(OSError):
                client.mutate("renew", expected_boot_id=self.boot, ttl_ms=60000)

    def test_read_status_uses_closed_projection(self):
        def hostile(*_args):
            return 200, {"generation": 0, "bootId": self.boot, "ownerToken": self.token, "unexpected": {"token": self.token}}
        with MODULE.DeploymentLeaseClient(hostile, self.path) as client:
            self.assertEqual(client.status(), {"generation": 0, "bootId": self.boot})

    def test_fifo_state_and_pending_are_rejected_without_blocking(self):
        for name in ["current.json", "pending.json"]:
            target = self.path / name
            os.mkfifo(target, 0o600)
            with MODULE.DeploymentLeaseClient(self.call, self.path) as client:
                with self.assertRaises(MODULE.LeaseClientError):
                    client.mutate("acquire", expected_boot_id=self.boot, expected_generation=0, ttl_ms=60000)
            target.unlink()
        self.assertEqual(self.calls, [])

    def test_oversized_corrupt_or_non_object_state_fails_closed(self):
        for contents in ["x" * 65537, "{", "[]", '{"ownerToken":"' + self.token + '"}']:
            state = self.path / "current.json"
            state.write_text(contents)
            state.chmod(0o600)
            with MODULE.DeploymentLeaseClient(self.call, self.path) as client:
                with self.assertRaises(MODULE.LeaseClientError) as error:
                    client.mutate("renew", expected_boot_id=self.boot, ttl_ms=60000)
                self.assertNotIn(self.token, str(error.exception))
        self.assertEqual(self.calls, [])

    def test_busy_journal_rejects_without_waiting_or_creating_intent(self):
        lock = os.open(self.path / "owner.lock", os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with MODULE.DeploymentLeaseClient(self.call, self.path) as client:
                with self.assertRaisesRegex(MODULE.LeaseClientError, "busy"):
                    client.mutate("acquire", expected_boot_id=self.boot, expected_generation=0, ttl_ms=60000)
            self.assertFalse((self.path / "pending.json").exists())
        finally:
            os.close(lock)

    def test_reconciles_completed_startup_only_by_exact_read_only_proof(self):
        qualification = {"expectedBootId": self.boot, "expectedGeneration": 0,
                         "qualificationSha256": "b" * 64, "expectedProtocolVersion": 1,
                         "expectedConfiguredControls": {"admission": True, "dispatch": True}}
        with MODULE.DeploymentLeaseClient(self.call, self.path) as client:
            client.mutate("acquire", expected_boot_id=self.boot, expected_generation=0, ttl_ms=60000)
            client.mutate("drain", expected_boot_id=self.boot)
            def lost_after_release(method, path, body):
                self.calls.append((method, path, body))
                if method == "POST" and path.endswith("/release"):
                    return 200, {"startupWork": {"held": False}}
                raise RuntimeError("fixture read response lost")
            client.call = lost_after_release
            with self.assertRaises(MODULE.LeaseClientError):
                client.mutate("startup-release", expected_boot_id=self.boot, qualification=qualification)
            count_before = len(self.calls)
            def read_only(method, path, body):
                self.calls.append((method, path, body))
                self.assertEqual(method, "GET")
                if path == "/api/startup-work-barrier":
                    return 200, {"startupWork": {"bootId": self.boot, "held": False, "generation": 1,
                                                "qualificationSha256": qualification["qualificationSha256"]},
                                 "startupRecovery": {"phase": "ready"}}
                return self.call(method, path, body)
            client.call = read_only
            with self.assertRaisesRegex(MODULE.LeaseClientError, "qualification mismatch"):
                client.reconcile_startup_release(expected_boot_id=self.boot, qualification={**qualification, "qualificationSha256": "c" * 64})
            self.assertEqual(len(self.calls), count_before)
            result = client.reconcile_startup_release(expected_boot_id=self.boot, qualification=qualification)
            self.assertTrue(result["reconciledByReadOnlyGet"])
            self.assertNotIn(self.token, json.dumps(result))
            self.assertFalse((self.path / "pending.json").exists())
            self.assertEqual(json.loads((self.path / "current.json").read_text())["generation"], 2)

    def test_unready_or_different_boot_cannot_acknowledge_uncertain_release(self):
        qualification = {"expectedBootId": self.boot, "expectedGeneration": 0, "qualificationSha256": "b" * 64}
        with MODULE.DeploymentLeaseClient(self.call, self.path) as client:
            client.mutate("acquire", expected_boot_id=self.boot, expected_generation=0, ttl_ms=60000)
            client.mutate("drain", expected_boot_id=self.boot)
            client.call = lambda *_args: (_ for _ in ()).throw(RuntimeError("fixture lost response"))
            with self.assertRaises(MODULE.LeaseClientError):
                client.mutate("startup-release", expected_boot_id=self.boot, qualification=qualification)
            for phase in ["starting", "recovering"]:
                client.call = lambda *_args: (200, {"startupWork": {"bootId": self.boot, "held": False, "generation": 1,
                                                                 "qualificationSha256": qualification["qualificationSha256"]},
                                                  "startupRecovery": {"phase": phase}})
                with self.assertRaises(MODULE.LeaseClientError):
                    client.reconcile_startup_release(expected_boot_id=self.boot, qualification=qualification)
                self.assertTrue((self.path / "pending.json").exists())


if __name__ == "__main__":
    unittest.main()
