#!/usr/bin/env python3
"""Repair writable home views once, retaining mount and privilege boundaries."""
import json
import os
from pathlib import PurePosixPath
import re
import signal
import subprocess
import sys
import time


PROGRESS_INTERVAL_SECONDS = 15
active_scan = None


def report(event, **fields):
    print(json.dumps({"event": event, **fields}, separators=(",", ":")), file=sys.stderr, flush=True)


def within(path, parent):
    return path == parent or path.startswith(parent.rstrip("/") + "/")


def mount_views(home):
    # JSON decodes spaces, tabs and backslashes; parsing findmnt's raw table
    # with shell read treats its escaped mount targets as different paths.
    raw = subprocess.check_output(
        ["findmnt", "--json", "--list", "--output", "TARGET,FSROOT,VFS-OPTIONS,MAJ:MIN,ID,PARENT"],
        stderr=subprocess.DEVNULL,
    )
    mounts = json.loads(raw)["filesystems"]
    for mount in mounts:
        mount["target"] = os.path.normpath(mount["target"])
        mount["fsroot"] = os.path.normpath(mount["fsroot"])
        mount["writable"] = "rw" in mount["vfs-options"].split(",")
    # A flattened mount table can include a hidden, overmounted view at the
    # same target. Do not guess which row authorizes a writable traversal.
    relevant = [m for m in mounts if within(home, m["target"]) or within(m["target"], home)]
    if len({m["target"] for m in relevant}) != len(relevant):
        raise ValueError("Ambiguous stacked mount view")
    containing = [m for m in mounts if within(home, m["target"])]
    if not containing:
        raise ValueError("Home has no authoritative mount metadata")
    backing = max(containing, key=lambda m: len(m["target"]))
    home_view = {
        **backing,
        "target": home,
        "fsroot": os.path.normpath(os.path.join(backing["fsroot"], os.path.relpath(home, backing["target"]))),
    }
    children = [m for m in mounts if m["target"] != home and within(m["target"], home)]
    for child in children:
        ancestors = [m for m in mounts if m["target"] != child["target"] and within(child["target"], m["target"])]
        # A later bind over an ordinary parent can hide an older child mount
        # without duplicate targets. Its mount parent then differs from the
        # nearest visible ancestor: pruning that row would skip real entries.
        if not ancestors or child["parent"] != max(ancestors, key=lambda m: len(m["target"]))["id"]:
            raise ValueError("Hidden nested mount view")
    views = [home_view, *children]
    for view in views:
        view["prune"] = [m["target"] for m in children if m["target"] != view["target"] and within(m["target"], view["target"])]
    return views


def identity(path):
    info = os.lstat(path)
    return info.st_dev, info.st_ino


def covered(view, completed):
    # A nested mount masks backing entries in that view. Keep both passes when
    # either view has any nested topology, rather than infer hidden coverage.
    if view["prune"]:
        return False
    for prior in completed:
        if prior["prune"] or prior["maj:min"] != view["maj:min"] or not within(view["fsroot"], prior["fsroot"]):
            continue
        relative = os.path.relpath(view["fsroot"], prior["fsroot"])
        visible = prior["target"]
        # find does not follow directory symlinks. Such a path cannot prove
        # that a sibling bind mount's backing entries were already visited.
        for part in PurePosixPath(relative).parts:
            if part == ".":
                continue
            visible = os.path.join(visible, part)
            if os.path.islink(visible):
                break
        else:
            if identity(visible) == identity(view["target"]):
                return True
    return False


def literal_find_path(path):
    return re.sub(r"([\\*?\[\]])", r"\\\1", path)


def stop(signum, _frame):
    if active_scan is not None:
        try:
            os.killpg(active_scan.pid, signum)
        except ProcessLookupError:
            pass
        try:
            active_scan.wait(timeout=10)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(active_scan.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            active_scan.wait()
    raise SystemExit(128 + signum)


def repair(view, uid, gid, ordinal, total):
    global active_scan
    started = time.monotonic()
    fields = {"root": ordinal, "roots": total, "target": view["target"], "uid": uid, "gid": gid}
    command = ["find", view["target"]]
    for target in view["prune"]:
        command += ["-path", literal_find_path(target), "-prune", "-o"]
    command += ["(", "!", "-uid", str(uid), "-o", "!", "-gid", str(gid), ")",
                "-exec", "chown", "--no-dereference", f"{uid}:{gid}", "{}", "+"]
    report("ownership_start", **fields)
    # No descendant filenames or credential contents enter startup logs, even
    # when find/chown fails. The root and exit status identify the failed phase.
    # This standalone Linux helper is single threaded. Block cancellation until
    # the child is registered, then restore the original mask in BOTH processes:
    # Popen's restore_signals restores dispositions, not the inherited signal mask.
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT})
    try:
        active_scan = subprocess.Popen(
            command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
            preexec_fn=lambda: signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask),
        )
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
    try:
        while True:
            try:
                code = active_scan.wait(timeout=PROGRESS_INTERVAL_SECONDS)
                break
            except subprocess.TimeoutExpired:
                report("ownership_progress", **fields, elapsedSeconds=round(time.monotonic() - started, 3))
        if code:
            report("ownership_failed", **fields, exitCode=code, elapsedSeconds=round(time.monotonic() - started, 3))
            raise subprocess.CalledProcessError(code, "ownership scan")
        report("ownership_complete", **fields, elapsedSeconds=round(time.monotonic() - started, 3))
    finally:
        active_scan = None


def main():
    home, raw_uid, raw_gid = sys.argv[1:]
    uid, gid = int(raw_uid), int(raw_gid)
    home = os.path.abspath(home)
    views = mount_views(home)
    writable = [view for view in views if view["writable"]]
    # Parents first in backing-filesystem order: a sibling alias of a subtree
    # may already be covered by the parent's complete, unmasked traversal.
    writable.sort(key=lambda view: (len(PurePosixPath(view["fsroot"]).parts), view["target"]))
    completed = []
    started = time.monotonic()
    for ordinal, view in enumerate(writable, 1):
        if covered(view, completed):
            report("ownership_alias_skipped", root=ordinal, roots=len(writable), target=view["target"])
            continue
        repair(view, uid, gid, ordinal, len(writable))
        completed.append(view)
    report("ownership_phase_complete", roots=len(writable), scannedRoots=len(completed),
           elapsedSeconds=round(time.monotonic() - started, 3))


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        report("ownership_phase_failed", errorType=type(error).__name__)
        raise SystemExit(1)
