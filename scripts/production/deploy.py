#!/usr/bin/env python3
"""Source provenance gate for Oxford's phased deployment guard. No Docker logic."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

SHA = re.compile(r"^[0-9a-f]{40}$")
IMAGE = re.compile(r"^sha256:[0-9a-f]{64}$")
GITHUB = re.compile(r"^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.git$")
ROLLBACK_ACTIONS = ("rollback_drain", "rollback_restore", "rollback_qualify", "rollback_release")
ACTIONS = ("prepare", "drain", "apply", "qualify_boot", "release", "rollback_drain",
           "rollback_restore", "rollback_qualify", "rollback_release", "reconcile_release")


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def command(args, cwd=None):
    # Do not print subprocess diagnostics: Git authentication helpers may include secrets.
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=60)
    require(result.returncode == 0, "provenance command failed: " + args[0])
    return result.stdout.strip()


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def sealed_file(item):
    path = Path(item["path"])
    require(path.is_absolute() and path.is_file(), "sealed input must be an absolute existing file")
    require(sha256(path) == item["sha256"], "sealed input changed")
    return path


def read_sealed(item):
    return json.loads(sealed_file(item).read_text())


def require_clean_checkout(source):
    # status/diff deliberately trust these index hints and can miss changed bytes.
    # A release checkout must not hide any tracked paths behind either hint.
    entries = command(["git", "ls-files", "-v", "-z"], source).split("\0")
    require(not any(entry and (entry[0].islower() or entry[0] == "S") for entry in entries),
            "candidate source index hides tracked files")
    require(not command(["git", "status", "--porcelain", "--untracked-files=all"], source),
            "candidate source checkout dirty")


def verify(manifest, *, allow_local_remote=False):
    require(manifest.get("schema") == "paperclip.production-provenance.v1", "unsupported manifest")
    remote, ref = manifest["githubRepository"], manifest["githubRef"]
    require(bool(GITHUB.fullmatch(remote)) or allow_local_remote, "GitHub HTTPS repository required")
    require(ref.startswith(("refs/heads/", "refs/tags/")), "full remote branch or tag ref required")
    command(["git", "check-ref-format", ref])
    frame = read_sealed(manifest["candidateFrame"])
    commit, tree, image = frame["candidateSourceCommit"], frame["candidateSourceTree"], frame["candidateImageId"]
    require(bool(SHA.fullmatch(commit)) and bool(SHA.fullmatch(tree)), "full source commit and tree required")
    require(bool(IMAGE.fullmatch(image)), "immutable candidate image required")
    source = Path(frame["sourceRepository"]).resolve()
    require(source.is_dir(), "candidate source checkout missing")
    require(command(["git", "rev-parse", "HEAD"], source) == commit, "candidate checkout HEAD mismatch")
    require(command(["git", "rev-parse", "HEAD^{tree}"], source) == tree, "candidate source tree mismatch")
    require_clean_checkout(source)
    for role in ("tests", "review"):
        receipt = read_sealed(manifest[role + "Receipt"])
        require(receipt.get("sourceCommit") == commit and receipt.get("sourceTree") == tree
                and receipt.get("imageId") == image, role + " receipt source/image mismatch")
        require(receipt.get("passed") is True, role + " receipt not passing")
        if role == "review":
            require(receipt.get("approved") is True, "review receipt not approved")
    sealed_file(manifest["guard"])
    # Fetch into an isolated temporary object database. Do not update the operator's
    # checkout, refs, lockfile or configured remotes. An advertised SHA alone is not
    # proof that GitHub can actually deliver the complete source commit/tree.
    with tempfile.TemporaryDirectory(prefix="paperclip-source-proof-") as directory:
        command(["git", "init", "--bare", "--quiet", directory])
        advertised = command(["git", "ls-remote", "--exit-code", "--refs", remote, ref])
        require(len(advertised.splitlines()) == 1, "remote ref missing or ambiguous")
        advertised_commit, advertised_ref = advertised.split()
        require(advertised_ref == ref, "unexpected remote ref")
        command(["git", "-C", directory, "fetch", "--quiet", "--depth=1", "--no-tags", remote, ref])
        fetched = command(["git", "-C", directory, "rev-parse", "FETCH_HEAD^{commit}"])
        require(fetched == commit, "GitHub source commit mismatch")
        fetched_tree = command(["git", "-C", directory, "rev-parse", "FETCH_HEAD^{tree}"])
        require(fetched_tree == tree, "GitHub source tree mismatch")
        require(command(["git", "ls-remote", "--exit-code", "--refs", remote, ref]) == advertised,
                "remote ref moved during verification")
        # Annotated tag advertisements name the tag object; fetch resolves its commit.
        require(SHA.fullmatch(advertised_commit) is not None, "invalid remote object identity")
    return {"passed": True, "sourceCommit": commit, "sourceTree": tree, "imageId": image,
            "githubRepository": remote, "githubRef": ref, "productionMutations": 0}


def run(manifest_path, action=None, execute=False, *, allow_local_remote=False):
    manifest_path = Path(manifest_path).resolve()
    original = manifest_path.read_bytes()
    manifest = json.loads(original)
    if action in ROLLBACK_ACTIONS:
        # Emergency restoration uses the existing guard's frozen, verified rollback
        # evidence. Never make recovery depend on fresh GitHub connectivity.
        require(execute, "explicit --execute required to invoke deployment guard")
        require(manifest.get("schema") == "paperclip.production-provenance.v1", "unsupported manifest")
        guard = sealed_file(manifest["guard"])
        require(manifest_path.read_bytes() == original, "manifest changed before rollback dispatch")
        result = subprocess.run([sys.executable, str(guard), action, "--execute"], check=False)
        require(result.returncode == 0, "deployment guard stopped; reconcile before retrying")
        return {"passed": True, "phase": action, "guardCompleted": True,
                "rollbackEvidence": "existing-guard-owned", "githubContacted": False,
                "productionMutations": "guard-owned"}
    proof = verify(manifest, allow_local_remote=allow_local_remote)
    if action is None:
        return proof
    require(action in ACTIONS, "unsupported guard phase")
    require(execute, "explicit --execute required to invoke deployment guard")
    # Recheck every bound input immediately before dispatch; the historical guard
    # independently checks its own frozen receipts and real GitHub review/CI gates.
    require(manifest_path.read_bytes() == original, "manifest changed during verification")
    for key in ("candidateFrame", "testsReceipt", "reviewReceipt", "guard"):
        sealed_file(manifest[key])
    frame = read_sealed(manifest["candidateFrame"])
    source = Path(frame["sourceRepository"])
    require(command(["git", "rev-parse", "HEAD"], source) == proof["sourceCommit"],
            "candidate source changed before dispatch")
    require_clean_checkout(source)
    argv = [sys.executable, str(sealed_file(manifest["guard"])), action, "--execute"]
    if action == "prepare":
        argv.extend(["--frame", str(sealed_file(manifest["candidateFrame"]))])
    result = subprocess.run(argv, check=False)
    require(result.returncode == 0, "deployment guard stopped; reconcile before retrying")
    return {**proof, "phase": action, "guardCompleted": True, "productionMutations": "guard-owned"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--phase", choices=ACTIONS)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(run(args.manifest, args.phase, args.execute)))
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        # Avoid echoing configuration or upstream stderr, which can contain credentials.
        reason = str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError) else type(error).__name__
        print(json.dumps({"passed": False, "stopped": True, "reason": reason}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
