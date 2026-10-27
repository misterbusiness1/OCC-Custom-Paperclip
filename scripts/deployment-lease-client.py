#!/usr/bin/env python3
"""Private, one-shot operator journal for the deployment-lease API.

The injected call function authenticates normally; this helper never loads a key.
It returns public metadata only. A pending intent blocks retries after an
ambiguous network/filesystem result; reconcile it without replaying the request.
"""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import re


class LeaseClientError(RuntimeError):
    pass


class DeploymentLeaseClient:
    PUBLIC_KEYS = ("protocolVersion", "generation", "bootId", "ownerBootId", "owned", "expired",
                   "startedAt", "expiresAt", "draining", "drainStartedAt")
    def __init__(self, call, state_directory):
        self.call = call
        self.directory = Path(state_directory)
        info = self.directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise LeaseClientError("lease state directory must be private and owned")
        self.directory_fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)

    def close(self):
        os.close(self.directory_fd)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()

    @contextlib.contextmanager
    def _lock(self):
        fd = os.open("owner.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, 0o600, dir_fd=self.directory_fd)
        try:
            self._check_private(fd)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise LeaseClientError("lease journal is busy") from None
            yield
        finally:
            os.close(fd)

    def _check_private(self, fd):
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
            raise LeaseClientError("lease state file must be private and owned")

    def _read(self, name, missing=False):
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=self.directory_fd)
        except FileNotFoundError:
            if missing:
                return None
            raise LeaseClientError("lease owner state missing") from None
        try:
            self._check_private(fd)
            if os.fstat(fd).st_size > 65536:
                raise LeaseClientError("lease state exceeds size limit")
            try:
                with os.fdopen(os.dup(fd), "rb") as stream:
                    data = stream.read(65537)
                if len(data) > 65536:
                    raise LeaseClientError("lease state exceeds size limit")
                value = json.loads(data)
            except (ValueError, UnicodeError):
                raise LeaseClientError("lease state is invalid") from None
            if not isinstance(value, dict):
                raise LeaseClientError("lease state must be an object")
            if name == "current.json":
                self._validate_owner(value)
            return value
        finally:
            os.close(fd)

    def _create(self, name, value):
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, 0o600, dir_fd=self.directory_fd)
        try:
            data = (json.dumps(value, sort_keys=True) + "\n").encode()
            with os.fdopen(os.dup(fd), "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        finally:
            os.close(fd)
        os.fsync(self.directory_fd)

    def _request(self, method, path, body=None):
        try:
            code, value = self.call(method, path, body)
        except Exception:
            # No arbitrary HTTP/library exception text can expose a capability.
            raise LeaseClientError("lease request outcome unknown; do not replay") from None
        if code != 200 or not isinstance(value, dict):
            raise LeaseClientError(f"lease request rejected with HTTP {int(code)}")
        return value

    def status(self):
        value = self._request("GET", "/api/instance/deployment-lease")
        return {key: value[key] for key in self.PUBLIC_KEYS if key in value}

    def _permit(self, owner, expected_boot_id):
        if not owner or not isinstance(owner.get("ownerToken"), str):
            raise LeaseClientError("usable private owner state required")
        return {"ownerToken": owner["ownerToken"], "expectedLeaseGeneration": owner["generation"],
                "expectedBootId": expected_boot_id}

    def _validate_owner(self, owner):
        uuid = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")
        token = owner.get("ownerToken")
        if (set(owner) != {"sequence", "ownerToken", "generation", "ownerBootId", "bootId"}
                or type(owner.get("sequence")) is not int or not 1 <= owner["sequence"] < 2**53
                or type(owner.get("generation")) is not int or not 0 <= owner["generation"] < 2**53
                or not isinstance(owner.get("bootId"), str) or not uuid.fullmatch(owner["bootId"])
                or (token is not None and (not isinstance(token, str) or not re.fullmatch(r"[a-f0-9]{64}", token)))
                or (token is not None and (not isinstance(owner.get("ownerBootId"), str) or not uuid.fullmatch(owner["ownerBootId"])))
                or (token is None and owner.get("ownerBootId") is not None)):
            raise LeaseClientError("lease owner state is invalid")

    def _finish(self, sequence, operation, lease, token, extra=None):
        state = {"sequence": sequence, "ownerToken": token, "generation": lease["generation"],
                 "ownerBootId": lease.get("ownerBootId"), "bootId": lease["bootId"]}
        self._validate_owner(state)
        state_name = f"owner-{sequence:06d}.json"
        self._create(state_name, state)
        public = {key: lease[key] for key in self.PUBLIC_KEYS if key in lease}
        receipt_name = f"receipt-{sequence:06d}.json"
        self._create(receipt_name, {"operation": operation, "status": public, **(extra or {})})
        self._create("next.json", state)
        os.replace("next.json", "current.json", src_dir_fd=self.directory_fd, dst_dir_fd=self.directory_fd)
        os.replace("pending.json", f"intent-{sequence:06d}.json", src_dir_fd=self.directory_fd, dst_dir_fd=self.directory_fd)
        os.fsync(self.directory_fd)
        return {"operation": operation, "status": public, **(extra or {}),
                "ownerStatePath": str(self.directory / state_name), "receiptPath": str(self.directory / receipt_name)}

    def reconcile_startup_release(self, *, expected_boot_id, qualification):
        """Read-only server reconciliation. Never sends a release POST or clears a drain."""
        with self._lock():
            pending = self._read("pending.json")
            owner = self._read("current.json")
            if (pending.get("operation") != "startup-release" or pending.get("expectedBootId") != expected_boot_id
                    or pending.get("sequence") != owner["sequence"] + 1
                    or not isinstance(qualification, dict) or "deploymentLease" in qualification):
                raise LeaseClientError("intent is not eligible for startup reconciliation")
            body = {**qualification, "deploymentLease": self._permit(owner, expected_boot_id)}
            digest = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
            if digest != pending.get("requestSha256"):
                raise LeaseClientError("startup reconciliation qualification mismatch")
            observed = self._request("GET", "/api/startup-work-barrier")
            boot = observed.get("startupWork") or {}
            if (boot.get("bootId") != expected_boot_id or boot.get("held") is not False
                    or boot.get("generation") != qualification.get("expectedGeneration", -2) + 1
                    or boot.get("qualificationSha256") != qualification.get("qualificationSha256")
                    or (observed.get("startupRecovery") or {}).get("phase") != "ready"):
                raise LeaseClientError("startup release is not yet verified; do not replay")
            lease = self.status()
            if (lease.get("bootId") != expected_boot_id or lease.get("ownerBootId") != owner["ownerBootId"]
                    or lease.get("generation") != owner["generation"] or lease.get("owned") is not True
                    or lease.get("expired") is not False or lease.get("draining") is not True):
                raise LeaseClientError("startup reconciliation owner mismatch")
            return self._finish(pending["sequence"], "startup-release", lease, owner["ownerToken"],
                                {"reconciledByReadOnlyGet": True, "qualificationSha256": qualification["qualificationSha256"]})

    def mutate(self, operation, *, expected_boot_id, expected_generation=None,
               ttl_ms=None, take_over_expired=False, qualification=None):
        with self._lock():
            if self._read("pending.json", missing=True) is not None:
                raise LeaseClientError("unreconciled lease intent exists; do not replay")
            owner = self._read("current.json", missing=True)
            sequence = 1 if owner is None else owner["sequence"] + 1
            if operation == "acquire":
                if expected_generation is None or ttl_ms is None:
                    raise LeaseClientError("acquisition needs exact generation and TTL")
                body = {"expectedBootId": expected_boot_id, "expectedLeaseGeneration": expected_generation,
                        "ttlMs": ttl_ms, "takeOverExpired": take_over_expired}
                method, path = "POST", "/api/instance/deployment-lease"
            else:
                body = self._permit(owner, expected_boot_id)
                if expected_generation is not None and expected_generation != owner["generation"]:
                    raise LeaseClientError("local owner generation mismatch")
                if operation == "adopt":
                    body["expectedOwnerBootId"] = owner["ownerBootId"]
                    method, path = "POST", "/api/instance/deployment-lease/adopt"
                elif operation == "renew":
                    if ttl_ms is None:
                        raise LeaseClientError("renewal needs TTL")
                    body["ttlMs"] = ttl_ms
                    method, path = "POST", "/api/instance/deployment-lease/renew"
                elif operation in ("drain", "clear-drain"):
                    body = {"deploymentLease": body}
                    method, path = ("POST" if operation == "drain" else "DELETE"), "/api/instance/task-drain"
                elif operation == "startup-release":
                    if not isinstance(qualification, dict) or "deploymentLease" in qualification or qualification.get("expectedBootId") != expected_boot_id:
                        raise LeaseClientError("qualified exact boot payload required")
                    body = {**qualification, "deploymentLease": body}
                    method, path = "POST", "/api/startup-work-barrier/release"
                elif operation == "release":
                    method, path = "DELETE", "/api/instance/deployment-lease"
                else:
                    raise LeaseClientError("unsupported lease operation")
            # The capability itself is intentionally absent from the intent.
            request_hash = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()
            self._create("pending.json", {"sequence": sequence, "operation": operation,
                                          "expectedBootId": expected_boot_id, "requestSha256": request_hash})
            result = self._request(method, path, body)
            if operation in ("drain", "clear-drain"):
                lease = result.get("deploymentLease")
            elif operation == "startup-release":
                lease = self.status()
            else:
                lease = result
            wanted_generation = (expected_generation + 1 if operation == "acquire" else
                                 owner["generation"] + (0 if operation == "startup-release" else 1))
            if (not isinstance(lease, dict) or lease.get("bootId") != expected_boot_id
                    or type(lease.get("generation")) is not int or lease["generation"] != wanted_generation):
                raise LeaseClientError("lease response mismatch; do not replay")
            token = result.get("ownerToken") if operation == "acquire" else owner["ownerToken"]
            if operation == "release":
                token = None
            if operation != "release" and (not isinstance(token, str) or len(token) != 64):
                raise LeaseClientError("lease capability response missing; do not replay")
            return self._finish(sequence, operation, lease, token)
