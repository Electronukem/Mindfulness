"""Pieces shared by the repository and meeting pipelines: background jobs, subprocesses,
finding graphify, and trimming a graphify graph down to a calm, coloured scene."""
from __future__ import annotations

import importlib.util
import os
import re
import shutil
import stat
import subprocess
import sys
import threading
import uuid
from collections import Counter, deque
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
CACHE_DIR = ROOT / ".cache"

MAX_COMMUNITIES = 18  # distinct colours before the smallest clusters share one
INSTALL_HINT = "pip install graphifyy"

_ANSI = re.compile(rb"\x1b\[[0-9;?]*[A-Za-z]")
_GENERIC_COMMUNITY = re.compile(r"^community\s*\d+$", re.I)


class BuildError(Exception):
    """A failure worth showing to the person, worded for them."""


# ---------------------------------------------------------------------------
# Jobs: building a scene takes a while, so the browser polls for progress.


class Job:
    def __init__(self) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.state = "running"
        self.step = "Getting ready"
        self.lines: deque[str] = deque(maxlen=40)
        self.result: dict | None = None
        self.error: str | None = None
        self._lock = threading.Lock()

    def update(self, step: str | None = None, line: str | None = None) -> None:
        with self._lock:
            if step:
                self.step = step
            if line:
                self.lines.append(line[:300])

    def finish(self, result: dict | None = None, error: str | None = None) -> None:
        with self._lock:
            self.result, self.error = result, error
            self.state = "error" if error else "done"

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "id": self.id,
                "state": self.state,
                "step": self.step,
                "log": list(self.lines)[-12:],
                "error": self.error,
                "result": self.result if self.state == "done" else None,
            }


JOBS: dict[str, Job] = {}
ACTIVE: dict[tuple, Job] = {}
JOBS_LOCK = threading.Lock()


def start_job(key: tuple, work: Callable[[Job], dict]) -> Job:
    """Run work(job) in the background, or return the job already doing the same thing."""
    with JOBS_LOCK:
        running = ACTIVE.get(key)
        if running and running.state == "running":
            return running
        job = Job()
        JOBS[job.id] = job
        ACTIVE[key] = job
        while len(JOBS) > 30:
            JOBS.pop(next(iter(JOBS)))
    threading.Thread(target=_run, args=(job, work), daemon=True).start()
    return job


def _run(job: Job, work: Callable[[Job], dict]) -> None:
    try:
        job.finish(result=work(job))
    except BuildError as exc:
        job.finish(error=str(exc))
    except Exception as exc:  # keep the page informative rather than spinning forever
        job.finish(error=f"Something unexpected went wrong: {exc}")


# ---------------------------------------------------------------------------
# Subprocesses and files


def stream(job: Job, cmd: list[str], *, timeout: float, cwd: Path | None = None, env: dict | None = None,
           on_line: Callable[[str], bool] | None = None):
    """Run cmd, echoing its output into the job log as it arrives. Returns (exit code, recent lines).

    on_line may claim a line (return True) to keep it out of the log, eg to turn progress
    messages into the job's step instead.
    """
    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, cwd=cwd, env=env
        )
    except OSError as exc:
        raise BuildError(f"Couldn't run {Path(cmd[0]).name}: {exc.strerror or exc}") from exc

    timed_out = threading.Event()

    def stop() -> None:
        timed_out.set()
        proc.kill()

    timer = threading.Timer(timeout, stop)
    timer.start()
    lines: deque[str] = deque(maxlen=200)

    def take(raw: bytes) -> None:
        text = _ANSI.sub(b"", raw).decode("utf-8", "replace").strip()
        if text and not (on_line and on_line(text)):
            lines.append(text)
            job.update(line=text)

    try:
        pending = b""
        while chunk := proc.stdout.read1(65536):
            pending += chunk
            *complete, pending = re.split(rb"[\r\n]", pending)  # git redraws progress with \r
            for raw in complete:
                take(raw)
        take(pending)
        code = proc.wait()
    finally:
        timer.cancel()
    if timed_out.is_set():
        raise BuildError(f"{Path(cmd[0]).name} took too long and was stopped.")
    return code, list(lines)


def rmtree(path: Path) -> None:
    def make_writable(func, target, _exc):  # git marks its objects read-only on Windows
        os.chmod(target, stat.S_IWRITE)
        func(target)

    if sys.version_info >= (3, 12):
        shutil.rmtree(path, onexc=make_writable)
    else:
        shutil.rmtree(path, onerror=make_writable)


# ---------------------------------------------------------------------------
# graphify


def graphify_command() -> list[str] | None:
    exe = shutil.which("graphify")
    if exe:
        return [exe]
    if importlib.util.find_spec("graphify") is not None:
        return [sys.executable, "-m", "graphify"]
    return None


def graphify_python() -> str | None:
    """The Python that graphify is installed in, for helpers that import it (and its extras)."""
    if importlib.util.find_spec("graphify") is not None:
        return sys.executable
    exe = shutil.which("graphify")
    if exe:
        folder = Path(exe).resolve().parent  # a virtual environment's Scripts/ or bin/
        for name in ("python.exe", "python", "python3"):
            if (folder / name).exists():
                return str(folder / name)
    return None


def summarize_graph(graph: dict, max_nodes: int, file_of: Callable[[dict], str],
                    fallback_group: Callable[[str], str]) -> dict:
    """Trim a graphify graph to its most connected nodes and colour it by community.

    Returns the kept nodes' labels, files, degrees and colour indices, the links between them
    (as index pairs), and the communities (largest first, smallest ones sharing a last colour).
    """
    raw_nodes = [n for n in graph.get("nodes", []) if isinstance(n, dict) and "id" in n]
    raw_links = graph.get("links") or graph.get("edges") or []
    index = {n["id"]: i for i, n in enumerate(raw_nodes)}

    degree = [0] * len(raw_nodes)
    pairs: set[tuple[int, int]] = set()
    for link in raw_links:
        s = index.get(_endpoint(link.get("source")))
        t = index.get(_endpoint(link.get("target")))
        if s is None or t is None or s == t:
            continue
        pair = (s, t) if s < t else (t, s)
        if pair not in pairs:
            pairs.add(pair)
            degree[s] += 1
            degree[t] += 1

    keep = sorted(range(len(raw_nodes)), key=lambda i: -degree[i])[:max_nodes]
    remap = {old: new for new, old in enumerate(keep)}
    links = sorted([remap[s], remap[t]] for s, t in pairs if s in remap and t in remap)
    files = [file_of(raw_nodes[old]) for old in keep]
    labels = [str(raw_nodes[old].get("label") or raw_nodes[old]["id"])[:80] for old in keep]

    # Colour by graphify's communities; if it skipped clustering, fall back to a grouping by file.
    raw_comm = [raw_nodes[old].get("community") for old in keep]
    by_fallback = all(c is None for c in raw_comm)
    if by_fallback:
        raw_comm = [fallback_group(f) for f in files]
    ranked = [c for c, _ in Counter(raw_comm).most_common()]
    colour = {c: i for i, c in enumerate(ranked[:MAX_COMMUNITIES])}
    comm = [colour.get(c, MAX_COMMUNITIES) for c in raw_comm]

    names: dict[int, str] = {}
    for new, old in enumerate(keep):  # keep is hub-first, so the first node seen names its cluster
        idx = comm[new]
        if idx in names or idx == MAX_COMMUNITIES:
            continue
        given = raw_nodes[old].get("community_name")
        if by_fallback:
            names[idx] = str(raw_comm[new])
        elif given and not _GENERIC_COMMUNITY.match(str(given)):
            names[idx] = str(given)
        else:
            names[idx] = labels[new]
    sizes = Counter(comm)
    communities = [{"name": names.get(i, ""), "size": sizes[i]} for i in range(min(len(ranked), MAX_COMMUNITIES))]
    if len(ranked) > MAX_COMMUNITIES:
        communities.append({"name": "Smaller clusters", "size": sizes[MAX_COMMUNITIES]})

    return {
        "raw_nodes": raw_nodes,
        "keep": keep,
        "degree": degree,
        "pair_count": len(pairs),
        "links": links,
        "files": files,
        "labels": labels,
        "comm": comm,
        "communities": communities,
    }


def _endpoint(value):
    return value.get("id") if isinstance(value, dict) else value
