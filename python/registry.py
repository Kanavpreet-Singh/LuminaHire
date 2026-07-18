"""
LuminaHire — In-Memory Task Registry
====================================
Tracks background vetting-pipeline runs keyed by sessionId. Lives in the
FastAPI process memory (no Redis/queue). This works because FastAPI
BackgroundTasks with plain `def` functions run in Starlette's threadpool in
the same process, so they share this module's state.

Lifecycle caveat (by design): if the process restarts (e.g. uvicorn --reload
on a file save, or a crash), the registry is wiped. The Next.js poll-through
layer treats a 404 from GET /vet/status/{id} while the DB still says RUNNING as
"restarted mid-run" -> marks the session FAILED with a restart hint. Run the
service single-worker and WITHOUT --reload during real runs.

Phases (HITL family): PLANNING -> RESEARCHING -> AWAITING_RESEARCH_INPUT ->
EVALUATING -> AWAITING_EVALUATION_APPROVAL -> COMPLETED | FAILED
Phases (non-HITL / run-full-async, resume-async): PLANNING -> RESEARCHING ->
EVALUATING -> COMPLETED | FAILED (skips both AWAITING_* checkpoints)
"""

import threading
import time
from typing import Any, Dict, List, Optional

# Terminal phases never transition further. AWAITING_* are included here (not
# just COMPLETED/FAILED) because they represent a completed background task
# now paused for human review -- the *next* stage's registry.create() call
# must be allowed to overwrite them, exactly like a COMPLETED run.
TERMINAL = {"COMPLETED", "FAILED", "AWAITING_RESEARCH_INPUT", "AWAITING_EVALUATION_APPROVAL"}


def _merge_logs_locked(entry: Dict[str, Any], logs: List[str]) -> List[str]:
    """
    Merge new log lines onto an entry's existing ones (append-only, no
    duplicates), instead of overwriting. Agent nodes call append_log() directly
    mid-execution for live step-by-step visibility (see agents.py's
    _emit_step); every *_progress/_results/_awaiting_*/_failed setter below
    also receives a `logs` snapshot from the LangGraph state's own (coarser,
    per-node) accumulator. Overwriting with that snapshot -- especially the
    terminal ones fired once at the very end of a run -- would silently wipe
    out every live step the moment the run finishes. Caller must hold _lock.
    """
    existing = entry.get("logs") or []
    seen = set(existing)
    merged = list(existing)
    for line in logs:
        if line not in seen:
            merged.append(line)
            seen.add(line)
    return merged

# Drop terminal entries older than this many seconds (lets pollers read the
# final result once, then reclaims memory).
_TTL_SECONDS = 3600

# Cap concurrent full pipelines to protect Gemini free-tier RPM during batch
# committee runs. Import and use as a context manager in the runner.
PIPELINE_SEMAPHORE = threading.Semaphore(2)

_lock = threading.Lock()
_tasks: Dict[str, Dict[str, Any]] = {}


def _now() -> float:
    return time.time()


def _purge_expired_locked() -> None:
    """Remove terminal entries past their TTL. Caller must hold _lock."""
    cutoff = _now() - _TTL_SECONDS
    stale = [
        sid for sid, e in _tasks.items()
        if e["phase"] in TERMINAL and e["updated_at"] < cutoff
    ]
    for sid in stale:
        _tasks.pop(sid, None)


def create(session_id: str, initial_phase: str = "PLANNING") -> bool:
    """
    Register a new run. Returns False if a run for this session_id already
    exists in a non-terminal phase (so the caller can return HTTP 409).
    A prior terminal entry is overwritten (allows re-runs / restarts).
    """
    with _lock:
        _purge_expired_locked()
        existing = _tasks.get(session_id)
        if existing and existing["phase"] not in TERMINAL:
            return False
        _tasks[session_id] = {
            "phase": initial_phase,
            "planner_output": None,
            "research_results": [],
            "evaluation": None,
            "final_report": None,
            "logs": [],
            "research_iterations": 0,
            "error": None,
            "started_at": _now(),
            "updated_at": _now(),
        }
        return True


def set_phase(session_id: str, phase: str) -> None:
    with _lock:
        e = _tasks.get(session_id)
        if e is not None:
            e["phase"] = phase
            e["updated_at"] = _now()


def set_planner_output(session_id: str, planner_output: Any) -> None:
    with _lock:
        e = _tasks.get(session_id)
        if e is not None:
            e["planner_output"] = planner_output
            e["updated_at"] = _now()


def set_progress(
    session_id: str,
    *,
    research_results: Optional[List[Any]] = None,
    research_iterations: Optional[int] = None,
    logs: Optional[List[str]] = None,
) -> None:
    """
    Update the streamed progress snapshot after a graph node completes.

    logs is MERGED, not replaced: LangGraph's stream() only yields once per
    node (not per line within a node), but agent nodes also call append_log()
    directly mid-execution for live step-by-step visibility (see agents.py's
    _emit_step). Overwriting here would wipe out those already-visible live
    lines the moment the node finishes and this fires with the node's own
    (coarser) accumulated logs. Merging keeps every live step line plus
    whatever new lines the node's return value adds, in order, no duplicates.
    """
    with _lock:
        e = _tasks.get(session_id)
        if e is None:
            return
        if research_results is not None:
            e["research_results"] = research_results
        if research_iterations is not None:
            e["research_iterations"] = research_iterations
        if logs is not None:
            e["logs"] = _merge_logs_locked(e, logs)
        e["updated_at"] = _now()


def append_log(session_id: str, line: str) -> None:
    """
    Append a single live step/tool-call line (e.g. "Fetching GitHub profile for
    @torvalds...") to an in-flight run, without touching phase/results. Called
    from inside agent nodes as they work so pollers see granular progress
    (Claude-Code-style step feed) instead of a single log line only once the
    whole node finishes.
    """
    with _lock:
        e = _tasks.get(session_id)
        if e is None:
            return
        e.setdefault("logs", []).append(line)
        e["updated_at"] = _now()


def set_awaiting_research(session_id: str, *, research_results: Any,
                          research_iterations: int, logs: List[str]) -> None:
    """Mark a run AWAITING_RESEARCH_INPUT: the first research pass finished and is paused for human review."""
    with _lock:
        e = _tasks.get(session_id)
        if e is None:
            return
        e["phase"] = "AWAITING_RESEARCH_INPUT"
        e["research_results"] = research_results
        e["research_iterations"] = research_iterations
        e["logs"] = _merge_logs_locked(e, logs)
        e["error"] = None
        e["updated_at"] = _now()


def set_awaiting_evaluation(session_id: str, *, evaluation: Any, research_results: Any,
                            research_iterations: int, logs: List[str]) -> None:
    """Mark a run AWAITING_EVALUATION_APPROVAL: evaluation settled and is paused for human review."""
    with _lock:
        e = _tasks.get(session_id)
        if e is None:
            return
        e["phase"] = "AWAITING_EVALUATION_APPROVAL"
        e["evaluation"] = evaluation
        e["research_results"] = research_results
        e["research_iterations"] = research_iterations
        e["logs"] = _merge_logs_locked(e, logs)
        e["error"] = None
        e["updated_at"] = _now()


def set_results(session_id: str, *, final_report: Any, research_results: Any,
                logs: List[str], research_iterations: int, planner_output: Any = None) -> None:
    """Mark a run COMPLETED with its final payload."""
    with _lock:
        e = _tasks.get(session_id)
        if e is None:
            return
        e["phase"] = "COMPLETED"
        e["final_report"] = final_report
        e["research_results"] = research_results
        e["logs"] = _merge_logs_locked(e, logs)
        e["research_iterations"] = research_iterations
        if planner_output is not None:
            e["planner_output"] = planner_output
        e["error"] = None
        e["updated_at"] = _now()


def set_failed(session_id: str, error: str) -> None:
    with _lock:
        e = _tasks.get(session_id)
        if e is None:
            # Create a minimal terminal entry so a poller sees FAILED, not 404.
            _tasks[session_id] = {
                "phase": "FAILED",
                "planner_output": None,
                "research_results": [],
                "evaluation": None,
                "final_report": None,
                "logs": [f"Pipeline failed: {error}"],
                "research_iterations": 0,
                "error": error,
                "started_at": _now(),
                "updated_at": _now(),
            }
            return
        e["phase"] = "FAILED"
        e["error"] = error
        e["updated_at"] = _now()


def get(session_id: str) -> Optional[Dict[str, Any]]:
    """Return a shallow copy of the entry, or None if unknown/expired."""
    with _lock:
        _purge_expired_locked()
        e = _tasks.get(session_id)
        if e is None:
            return None
        return dict(e)
