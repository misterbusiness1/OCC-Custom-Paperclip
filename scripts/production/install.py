#!/usr/bin/env python3
"""Install the reviewed production launcher. Never invoke a deployment guard."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

SOURCE_PATH = "scripts/production/deploy.py"


def require(ok, message):
    if not ok:
        raise ValueError(message)


def git(source, *args):
    result = subprocess.run(["git", "-C", str(source), *args], capture_output=True, timeout=30)
    require(result.returncode == 0, "source Git verification failed")
    return result.stdout


def digest(data):
    return hashlib.sha256(data).hexdigest()


def atomic_write(path, data, mode):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
        temporary.write(data)
        temporary.flush()
        os.fsync(temporary.fileno())
        temporary_path = Path(temporary.name)
    try:
        temporary_path.chmod(mode)
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def install(source, commit, bin_dir, state_dir):
    source = Path(source).resolve()
    require(re.fullmatch(r"[0-9a-f]{40}", commit) is not None, "full source commit required")
    require(git(source, "rev-parse", "HEAD").decode().strip() == commit, "source HEAD mismatch")
    index = git(source, "ls-files", "-v", "-z").decode().split("\0")
    require(not any(x and (x[0].islower() or x[0] == "S") for x in index), "source index hides tracked files")
    require(not git(source, "status", "--porcelain", "--untracked-files=all").strip(), "source checkout dirty")
    helper_bytes = git(source, "show", commit + ":" + SOURCE_PATH)
    require((source / SOURCE_PATH).read_bytes() == helper_bytes, "source helper differs from pinned commit")
    helper_hash = digest(helper_bytes)
    bin_dir, state_dir = Path(bin_dir).absolute(), Path(state_dir).absolute()
    require(bin_dir.resolve() == bin_dir and state_dir.resolve() == state_dir, "destination directory symlinks refused")
    command = bin_dir / "paperclip-production-deploy"
    receipt_path = state_dir / "production-launcher-adoption.json"
    require(not command.is_symlink() and not receipt_path.is_symlink(), "launcher/receipt symlinks refused")
    previous = None
    if receipt_path.exists():
        previous = json.loads(receipt_path.read_text())
        require(previous.get("schema") == "paperclip.production-launcher-adoption.v1"
                and previous.get("commandPath") == str(command), "existing receipt does not own command")
    if command.exists():
        require(previous is not None and digest(command.read_bytes()) == previous.get("launcherSha256"),
                "refusing to overwrite unrelated or modified command")
    helper_dir = state_dir / "production-launcher" / helper_hash
    require(helper_dir.resolve() == helper_dir, "installed helper directory symlinks refused")
    helper_path = helper_dir / "deploy.py"
    require(not helper_path.is_symlink(), "installed helper symlink refused")
    if helper_path.exists():
        require(digest(helper_path.read_bytes()) == helper_hash, "existing installed helper changed")
    launcher = ("#!/usr/bin/env python3\n"
                "# Managed Paperclip production launcher; update using scripts/production/install.py.\n"
                "import hashlib, pathlib, sys\n"
                "p = pathlib.Path(" + repr(str(helper_path)) + ")\n"
                "try:\n"
                "    code = p.read_bytes()\n"
                "except OSError:\n"
                "    sys.exit('Pinned production helper unavailable; deployment stopped')\n"
                "if hashlib.sha256(code).hexdigest() != " + repr(helper_hash) + ":\n"
                "    sys.exit('Pinned production helper changed; deployment stopped')\n"
                "exec(compile(code, str(p), 'exec'), {'__name__': '__main__', '__file__': str(p)})\n").encode()
    receipt = {"schema": "paperclip.production-launcher-adoption.v1", "sourceCommit": commit,
               "sourceFile": SOURCE_PATH, "helperSha256": helper_hash, "helperPath": str(helper_path),
               "commandPath": str(command), "launcherSha256": digest(launcher),
               "installedAt": datetime.now(timezone.utc).isoformat(), "productionMutations": 0}
    # Installation only changes local launcher artifacts; no guard import or execution.
    bin_dir.mkdir(parents=True, exist_ok=True)
    helper_dir.mkdir(parents=True, exist_ok=True)
    if not helper_path.exists():
        atomic_write(helper_path, helper_bytes, 0o644)
    atomic_write(command, launcher, 0o755)
    atomic_write(receipt_path, (json.dumps(receipt, indent=2) + "\n").encode(), 0o600)
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--bin-dir", default=str(Path.home() / ".local/bin"))
    parser.add_argument("--state-dir", default=str(Path.home() / ".local/share/paperclip"))
    args = parser.parse_args()
    try:
        print(json.dumps(install(args.source, args.source_commit, args.bin_dir, args.state_dir)))
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError):
        print("Production launcher installation refused; source or destination verification failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
