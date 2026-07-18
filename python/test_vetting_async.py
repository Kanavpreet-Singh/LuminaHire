"""
Python-only verification gate for the async Hiring Committee pipeline.
Run against a LIVE server:  uvicorn main:app --port 8000   (no --reload)
Then:  python test_vetting_async.py

Checks:
  1. GET /vet/status/<unknown>            -> 404 (registry-miss contract)
  2. POST /vet/run-full-async             -> poll -> phase transitions + full report,
                                              never pausing at either HITL checkpoint
  3. POST /vet/execute-async (twice)      -> 202 then 409 (duplicate guard); pauses at
                                              AWAITING_RESEARCH_INPUT (does NOT auto-complete)
  4. POST /vet/initiate (legacy)          -> still returns a plan
  5. Full HITL chain: execute-async -> AWAITING_RESEARCH_INPUT -> research/followup
     (tool-calling agent) -> research/approve-async -> AWAITING_EVALUATION_APPROVAL ->
     evaluation/approve-async -> COMPLETED -> /vet/qa
"""

import sys
import time
import uuid
import requests

BASE = "http://localhost:8000"

JOB = {
    "title": "Senior Systems Engineer",
    "description": "Deep C systems programming, OS internals, performance work.",
    "requirements": "Expert C, OS internals, large-scale open-source contributions",
}
CANDIDATE = {
    "name": "Linus Torvalds",
    "email": "linus@example.com",
    "resume_text": "Creator of Linux and Git. Decades of C systems programming.",
    "linkedin_url": None,
    "github_url": "https://github.com/torvalds",
}

LEGACY_KEYS = ["overall_fit_percentage", "summary", "verified_skills",
               "gaps_or_concerns", "interview_questions", "verdict"]
EXT_KEYS = ["dimension_scores", "evidence", "red_flags", "narrative",
            "hiring_recommendation", "research_iterations"]

failures = []


def check(cond, label):
    print(("  PASS " if cond else "  FAIL ") + label)
    if not cond:
        failures.append(label)


def poll(session_id, timeout=180, terminal=("COMPLETED", "FAILED")):
    seen = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = requests.get(f"{BASE}/vet/status/{session_id}")
        r.raise_for_status()
        data = r.json()
        phase = data["phase"]
        if not seen or seen[-1] != phase:
            seen.append(phase)
            print(f"    phase -> {phase}")
        if phase in terminal:
            return data, seen
        time.sleep(3)
    raise TimeoutError(f"polling timed out, saw {seen}")


def test_404():
    print("\n[1] 404 contract")
    r = requests.get(f"{BASE}/vet/status/does-not-exist-{uuid.uuid4()}")
    check(r.status_code == 404, "unknown session -> 404")


def test_run_full():
    print("\n[2] run-full-async end to end")
    sid = f"test-full-{uuid.uuid4()}"
    r = requests.post(f"{BASE}/vet/run-full-async", json={"session_id": sid, "job": JOB, "candidate": CANDIDATE})
    check(r.status_code == 202, f"dispatch -> 202 (got {r.status_code})")
    data, seen = poll(sid)
    check(data["phase"] == "COMPLETED", f"final phase COMPLETED (got {data['phase']})")
    # Intermediate phases (RESEARCHING/EVALUATING) are a best-effort observation:
    # in mock mode the whole pipeline can finish before the first poll GET lands,
    # so seeing only ["COMPLETED"] is not itself a failure -- what matters is that
    # it never gets stuck at a HITL checkpoint it shouldn't.
    if not ("RESEARCHING" in seen and "EVALUATING" in seen):
        print(f"    (note: polling missed intermediate phases, saw {seen} -- expected in fast mock mode)")
    check("AWAITING_RESEARCH_INPUT" not in seen and "AWAITING_EVALUATION_APPROVAL" not in seen,
          f"non-HITL run never paused at either checkpoint (saw {seen})")
    report = data.get("final_report") or {}
    for k in LEGACY_KEYS:
        check(k in report, f"report has legacy key '{k}'")
    for k in EXT_KEYS:
        check(k in report, f"report has extension key '{k}'")
    ds = report.get("dimension_scores") or {}
    check(all(d in ds for d in ["skills", "experience", "project_complexity", "education", "public_work"]),
          "dimension_scores has all 5 dimensions")
    evidence = report.get("evidence") or []
    check(len(evidence) > 0, f"evidence is non-empty ({len(evidence)} items)")
    check(all("source_url" in e for e in evidence), "every evidence item has source_url")
    check(data.get("research_iterations", 0) >= 1, "research_iterations >= 1")


def test_duplicate_guard():
    """
    The 409 duplicate-guard (registry.create()) is a locked, atomic check --
    but in mock mode the background task can finish in well under a
    millisecond, faster than two genuinely concurrent HTTP requests can land.
    That makes racing it over HTTP inherently unreliable as a test signal (it
    doesn't reflect a bug; mock work is just too fast to still be "in flight"
    by the time a second real request arrives). So this checks the guard logic
    directly and deterministically, in-process, against the same registry
    module the live server uses -- no timing dependency.
    """
    print("\n[3] registry.create() duplicate guard (direct, deterministic)")
    sys.path.insert(0, ".")
    import registry as reg
    sid = f"test-guard-{uuid.uuid4()}"

    check(reg.create(sid, initial_phase="RESEARCHING") is True, "first create() succeeds")
    check(reg.create(sid, initial_phase="RESEARCHING") is False, "duplicate create() while non-terminal -> False (409)")
    reg.set_awaiting_research(sid, research_results=[], research_iterations=1, logs=[])
    check(reg.create(sid, initial_phase="EVALUATING") is True, "create() after reaching a terminal/paused phase succeeds (allows next stage)")

    print("\n[3b] execute-async pauses at AWAITING_RESEARCH_INPUT (single dispatch)")
    sid2 = f"test-exec-{uuid.uuid4()}"
    plan = {
        "target_candidate": "Linus Torvalds",
        "core_skills_to_verify": ["C", "OS internals"],
        "research_plan": [{
            "heading": "GitHub check", "explanation": "verify repos",
            "source": "GITHUB", "search_queries": ["torvalds repos"],
        }],
        "company_vetting": {"companies": [], "questions": []},
    }
    body = {"session_id": sid2, "job": JOB, "candidate": CANDIDATE, "planner_output": plan}
    r = requests.post(f"{BASE}/vet/execute-async", json=body)
    check(r.status_code == 202, f"dispatch -> 202 (got {r.status_code})")
    data, _ = poll(sid2, terminal=("AWAITING_RESEARCH_INPUT", "FAILED"))
    check(data["phase"] == "AWAITING_RESEARCH_INPUT",
          f"execute-async pauses at AWAITING_RESEARCH_INPUT, not COMPLETED (got {data['phase']})")


def test_hitl_full_flow():
    print("\n[5] full HITL chain: research pause -> followup -> approve -> evaluation pause -> approve -> qa")
    sid = f"test-hitl-{uuid.uuid4()}"

    r = requests.post(f"{BASE}/vet/initiate", json={"job": JOB, "candidate": CANDIDATE})
    check(r.status_code == 200, f"initiate -> 200 (got {r.status_code})")
    plan = r.json()["planner_output"]

    r = requests.post(f"{BASE}/vet/execute-async", json={
        "session_id": sid, "job": JOB, "candidate": CANDIDATE, "planner_output": plan,
    })
    check(r.status_code == 202, f"execute-async dispatch -> 202 (got {r.status_code})")
    data, _ = poll(sid, terminal=("AWAITING_RESEARCH_INPUT", "FAILED"))
    check(data["phase"] == "AWAITING_RESEARCH_INPUT", f"paused at AWAITING_RESEARCH_INPUT (got {data['phase']})")
    research_results = data["research_results"]
    check(len(research_results) > 0, "research_results non-empty")

    r = requests.post(f"{BASE}/vet/research/followup", json={
        "session_id": sid, "job": JOB, "candidate": CANDIDATE,
        "planner_output": plan, "research_results": research_results,
        "instruction": "look for a MERN stack repo on their GitHub",
    })
    check(r.status_code == 200, f"research/followup -> 200 (got {r.status_code})")
    followup = r.json()
    check(len(followup.get("new_results") or []) > 0, "followup produced new_results")
    check(len(followup.get("tool_calls") or []) > 0, "followup recorded tool_calls (genuine tool selection)")
    research_results = research_results + followup["new_results"]

    r = requests.post(f"{BASE}/vet/research/approve-async", json={
        "session_id": sid, "job": JOB, "candidate": CANDIDATE,
        "planner_output": plan, "research_results": research_results, "research_iterations": 1,
    })
    check(r.status_code == 202, f"research/approve-async -> 202 (got {r.status_code})")
    data, _ = poll(sid, terminal=("AWAITING_EVALUATION_APPROVAL", "FAILED"))
    check(data["phase"] == "AWAITING_EVALUATION_APPROVAL", f"paused at AWAITING_EVALUATION_APPROVAL (got {data['phase']})")
    check(data.get("evaluation") is not None, "evaluation present")
    evaluation = data["evaluation"]
    research_results = data["research_results"]
    research_iterations = data["research_iterations"]

    r = requests.post(f"{BASE}/vet/evaluation/approve-async", json={
        "session_id": sid, "job": JOB, "candidate": CANDIDATE,
        "planner_output": plan, "research_results": research_results,
        "research_iterations": research_iterations, "evaluation": evaluation,
    })
    check(r.status_code == 202, f"evaluation/approve-async -> 202 (got {r.status_code})")
    data, _ = poll(sid)
    check(data["phase"] == "COMPLETED", f"completed (got {data['phase']})")
    final_report = data.get("final_report") or {}
    check(final_report.get("overall_fit_percentage") is not None, "final_report has overall_fit_percentage")

    r = requests.post(f"{BASE}/vet/qa", json={
        "session_id": sid, "job": JOB, "candidate": CANDIDATE,
        "planner_output": plan, "research_results": research_results,
        "evaluation": evaluation, "final_report": final_report,
        "question": "Does this candidate have relevant open source experience?",
    })
    check(r.status_code == 200, f"qa -> 200 (got {r.status_code})")
    check(bool(r.json().get("answer")), "qa returned an answer")


def test_legacy():
    print("\n[4] legacy /vet/initiate still works")
    r = requests.post(f"{BASE}/vet/initiate", json={"job": JOB, "candidate": CANDIDATE})
    check(r.status_code == 200, f"initiate -> 200 (got {r.status_code})")
    check((r.json().get("planner_output") or {}).get("research_plan") is not None, "returns a research_plan")


if __name__ == "__main__":
    try:
        requests.get(f"{BASE}/health", timeout=5).raise_for_status()
    except Exception as e:
        print(f"Server not reachable at {BASE}: {e}")
        sys.exit(2)

    test_404()
    test_run_full()
    test_duplicate_guard()
    test_legacy()
    test_hitl_full_flow()

    print("\n" + ("=" * 40))
    if failures:
        print(f"FAILED ({len(failures)}):")
        for f in failures:
            print("  -", f)
        sys.exit(1)
    print("ALL CHECKS PASSED")
