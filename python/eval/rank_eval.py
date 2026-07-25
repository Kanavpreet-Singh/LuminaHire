from __future__ import annotations

"""
LuminaHire — Ranking Accuracy/Stability Eval Harness
=====================================================
Compares two ways of ranking a shortlist of already-evaluated candidates for
the same job:

  OLD METHOD: sort by each candidate's own independently-produced absolute
              fit score -- today's production behavior before this change.
  NEW METHOD: agents.run_pairwise_tournament -- round-robin, head-to-head
              comparisons, position-bias-cancelled (see agents.py).

Each fixture below is a job + a small set of synthetic candidate profiles
with an AUTHORED, documented ground-truth ordering (deliberately obvious
tiering -- senior > mid > junior > mismatch -- so disagreement is
attributable to ranking noise, not genuine ambiguity). For each fixture, both
methods are run --runs times (default 5); each run makes FRESH independent
per-candidate evaluation LLM calls (real sampling variance) and a fresh
tournament. Two metrics are reported per method:

  ACCURACY:  average Kendall-tau rank agreement vs the authored ground truth.
  STABILITY: average pairwise Kendall-tau agreement BETWEEN the method's own
             repeated runs on the IDENTICAL input -- i.e. how much the
             ranking changes run-to-run. This is the direct measure of
             "ordering is partly noise," independent of any ground truth.

Usage:
  python eval/rank_eval.py                        # mock mode: fast plumbing check, $0
  MOCK_AI_RESPONSES=0 python eval/rank_eval.py --runs 5   # real LLM: the actual proof run
"""

import argparse
import itertools
import os
import sys
import time
from typing import Any, Dict, List

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import agents
import llm_client

USE_MOCK_AI = agents.USE_MOCK_AI


# ── Synthetic fixtures ──────────────────────────────────────────────────────

FIXTURES: List[Dict[str, Any]] = [
    {
        "name": "backend_engineer",
        "job": {
            "title": "Senior Backend Engineer",
            "description": "Own our Node.js/Postgres API platform: design schemas, scale services under real production load, mentor other engineers.",
            "requirements": "5+ years backend experience, strong Postgres/SQL, production-scale distributed systems, mentorship experience.",
            "recruiter_instructions": None,
        },
        "candidates": [
            {
                # Close pair #1: both strong, real but SUBTLE edge -- this is the
                # scenario independent absolute scoring is most likely to get
                # wrong/inconsistent (both land in the same "high 80s" band),
                # while a direct side-by-side comparison can weigh the specific
                # differentiator explicitly.
                "id": "sr_backend_scale",
                "name": "Priya (Senior, production scale)",
                "profile_text": (
                    "6 years backend engineering. Designed and scaled a multi-region Postgres-backed "
                    "payments API handling 50M requests/day at a Series C startup -- directly comparable "
                    "production scale to what this role requires. Led two zero-downtime schema migrations "
                    "under real load. Mentored 2 junior engineers."
                ),
                "intended_score": 88,
            },
            {
                "id": "sr_backend_years",
                "name": "Noah (Senior, more years, smaller scale)",
                "profile_text": (
                    "9 years backend engineering, all at a small internal-tools team supporting roughly "
                    "5k requests/day -- never operated at production scale under real load or led a schema "
                    "migration with users on the system. Strong Postgres fundamentals and has mentored 3 "
                    "junior engineers over the years."
                ),
                "intended_score": 86,
            },
            {
                "id": "junior_backend",
                "name": "Sam (Junior)",
                "profile_text": (
                    "1.5 years experience, primarily frontend work with some small internal Node.js "
                    "scripts touching a Postgres database. No experience designing schemas or handling "
                    "production incidents. Eager to grow into backend work."
                ),
                "intended_score": 45,
            },
            {
                "id": "mismatch",
                "name": "Alex (Mismatch)",
                "profile_text": (
                    "6 years experience as a mobile iOS engineer (Swift/SwiftUI). No backend, SQL, or "
                    "Postgres experience mentioned anywhere in their background."
                ),
                "intended_score": 20,
            },
        ],
        # Best fit -> worst fit. Reasoning for the close top pair: the role
        # explicitly requires "production-scale distributed systems" -- Priya
        # has directly comparable real-world scale (50M req/day, migrations
        # under live load); Noah has more raw years but at toy-scale traffic,
        # which is the weaker match for THIS specific requirement despite the
        # longer tenure. A real recruiter reading both profiles side by side
        # would pick Priya; an independent 0-100 score for each in isolation
        # can easily land Noah >= Priya since "9 years" reads as more senior
        # than "6 years" without the scale caveat being weighted correctly.
        "ground_truth": ["sr_backend_scale", "sr_backend_years", "junior_backend", "mismatch"],
    },
    {
        "name": "frontend_engineer",
        "job": {
            "title": "Senior Frontend Engineer (React)",
            "description": "Own our customer-facing React/TypeScript dashboard: component architecture, performance, accessibility.",
            "requirements": "5+ years frontend experience, deep React/TypeScript expertise, performance optimization, accessibility (a11y) experience.",
            "recruiter_instructions": None,
        },
        "candidates": [
            {
                # Close pair #2: React/TS depth vs. raw seniority + generic
                # frontend breadth -- both plausible reads as "the strong one"
                # depending on how heavily a4y/perf specifics get weighted.
                "id": "sr_frontend_react",
                "name": "Wei (Senior, deep React/TS)",
                "profile_text": (
                    "5 years frontend engineering, all focused on React/TypeScript. Rebuilt a dashboard's "
                    "rendering pipeline to cut load time by 60%, led an accessibility audit that brought "
                    "the app to WCAG AA compliance -- both explicitly called for in this role."
                ),
                "intended_score": 87,
            },
            {
                "id": "sr_frontend_broad",
                "name": "Casey (Senior, broad but less TS-specific)",
                "profile_text": (
                    "8 years frontend engineering across React, Vue, and Angular at various companies -- "
                    "more total tenure, but TypeScript-specific work is limited to the last 18 months, and "
                    "no accessibility or performance-optimization work is mentioned anywhere."
                ),
                "intended_score": 85,
            },
            {
                "id": "junior_frontend",
                "name": "Taylor (Junior)",
                "profile_text": (
                    "1 year experience, bootcamp graduate, built small React todo-list style projects. "
                    "No production experience, no performance or accessibility work."
                ),
                "intended_score": 42,
            },
            {
                "id": "mismatch",
                "name": "Morgan (Mismatch)",
                "profile_text": (
                    "7 years experience as a backend Java engineer. No React, TypeScript, or frontend "
                    "experience mentioned."
                ),
                "intended_score": 18,
            },
        ],
        # Best fit -> worst fit. Reasoning for the close top pair: the role
        # explicitly requires "deep React/TypeScript expertise... performance
        # optimization... accessibility" -- Wei has all three specifically;
        # Casey has more total years but shallower TypeScript depth and no
        # a11y/perf work, which is the weaker match for THIS role's stated
        # requirements despite the longer overall tenure.
        "ground_truth": ["sr_frontend_react", "sr_frontend_broad", "junior_frontend", "mismatch"],
    },
]


def _mock_independent_evaluation(candidate: Dict[str, Any]) -> Dict[str, Any]:
    score = candidate["intended_score"]
    return {
        "dimension_scores": {"skills": score, "experience": score, "project_complexity": score, "education": 70, "public_work": score},
        "overall_fit_percentage": score,
        "verified_skills": [],
        "gaps_or_concerns": [],
        "evidence": [{"claim": candidate["profile_text"][:120], "source_url": "resume", "source_type": "RESUME"}],
        "evidence_sufficient": True,
        "additional_research_requests": [],
    }


def simulate_independent_evaluation(job: Dict[str, Any], candidate: Dict[str, Any]) -> Dict[str, Any]:
    """
    Stands in for the real pipeline's per-candidate Evaluator call (own
    context, own evidence, own sampling variance) -- this is what produces
    the OLD method's absolute overall_fit_percentage today. In mock mode this
    is fully deterministic (uses the fixture's authored intended_score)
    purely so the harness's own plumbing/aggregation can be checked instantly
    and for free -- the actual accuracy/stability proof requires real mode,
    where the LLM judges the profile text with zero knowledge of intended_score.
    """
    if USE_MOCK_AI:
        return _mock_independent_evaluation(candidate)

    prompt = f"""
You are the Technical Evaluator Agent -- an impartial judge. Assess this candidate
against the job below, based STRICTLY on the profile text provided (do not invent
facts). Score each dimension 0-100.

JOB DETAILS:
Title: {job['title']}
Description: {job['description']}
Requirements: {job.get('requirements') or "N/A"}

CANDIDATE: {candidate['name']}
Profile: {candidate['profile_text']}
"""
    # A transient network hiccup shouldn't torch an entire multi-run harness
    # invocation (the production tournament path already degrades gracefully
    # on failure via _pairwise_compare_safe in agents.py; this eval-only call
    # gets the same resilience via retry instead, since we want a genuine
    # evaluation each time, not a fallback guess).
    last_exc: Exception | None = None
    for attempt in range(3):
        try:
            return llm_client.structured_generate(prompt, agents.EvaluatorOutputSchema, temperature=0.4)
        except Exception as e:
            last_exc = e
            print(f"  [retry {attempt + 1}/3] evaluation call failed for {candidate['name']}: {e}")
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"Evaluation call failed after 3 attempts for {candidate['name']}") from last_exc


def rank_by_absolute_score(evaluations: Dict[str, Dict[str, Any]]) -> List[str]:
    return sorted(evaluations.keys(), key=lambda cid: -(evaluations[cid].get("overall_fit_percentage") or 0))


def rank_by_tournament(job: Dict[str, Any], candidates: List[Dict[str, Any]], evaluations: Dict[str, Dict[str, Any]]) -> List[str]:
    shortlist = [
        {
            "session_id": c["id"],
            "name": c["name"],
            "evaluation": evaluations[c["id"]],
            "overall_fit_percentage": evaluations[c["id"]].get("overall_fit_percentage"),
        }
        for c in candidates
    ]
    result = agents.run_pairwise_tournament(job, shortlist)
    return result["ranking"]


def kendall_tau_agreement(rank_a: List[str], rank_b: List[str]) -> float:
    """1.0 = identical order, 0.0 = fully reversed, over the pairs common to both rankings."""
    ids = [x for x in rank_a if x in rank_b]
    if len(ids) < 2:
        return 1.0
    pos_a = {cid: i for i, cid in enumerate(rank_a)}
    pos_b = {cid: i for i, cid in enumerate(rank_b)}
    concordant = 0
    total = 0
    for x, y in itertools.combinations(ids, 2):
        total += 1
        if (pos_a[x] - pos_a[y] > 0) == (pos_b[x] - pos_b[y] > 0):
            concordant += 1
    return concordant / total if total else 1.0


def run_fixture(fixture: Dict[str, Any], runs: int) -> Dict[str, Any]:
    job = fixture["job"]
    candidates = fixture["candidates"]
    ground_truth = fixture["ground_truth"]

    old_rankings: List[List[str]] = []
    new_rankings: List[List[str]] = []

    for run_idx in range(runs):
        evaluations = {c["id"]: simulate_independent_evaluation(job, c) for c in candidates}
        old_rankings.append(rank_by_absolute_score(evaluations))
        new_rankings.append(rank_by_tournament(job, candidates, evaluations))
        print(f"  [{fixture['name']}] run {run_idx + 1}/{runs} done -- old: {old_rankings[-1]} | new: {new_rankings[-1]}")

    def summarize(rankings: List[List[str]]) -> Dict[str, float]:
        accuracy = sum(kendall_tau_agreement(r, ground_truth) for r in rankings) / len(rankings)
        top1 = sum(1 for r in rankings if r and r[0] == ground_truth[0]) / len(rankings)
        if len(rankings) < 2:
            stability = 1.0
        else:
            pairs = list(itertools.combinations(range(len(rankings)), 2))
            stability = sum(kendall_tau_agreement(rankings[i], rankings[j]) for i, j in pairs) / len(pairs)
        return {"accuracy": accuracy, "top1": top1, "stability": stability}

    return {
        "fixture": fixture["name"],
        "old": summarize(old_rankings),
        "new": summarize(new_rankings),
        "old_rankings": old_rankings,
        "new_rankings": new_rankings,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Ranking accuracy/stability eval harness")
    parser.add_argument("--runs", type=int, default=5, help="Repetitions per fixture (default 5)")
    args = parser.parse_args()

    print(f"Mode: {'MOCK' if USE_MOCK_AI else 'REAL LLM'} | runs per fixture: {args.runs}\n")

    results = [run_fixture(f, args.runs) for f in FIXTURES]

    print(f"{'Fixture':<20} {'Method':<18} {'Accuracy':>10} {'Top-1':>8} {'Stability':>10}")
    print("-" * 68)
    for r in results:
        print(f"{r['fixture']:<20} {'old (absolute)':<18} {r['old']['accuracy']:>10.2f} {r['old']['top1']:>8.2f} {r['old']['stability']:>10.2f}")
        print(f"{'':<20} {'new (tournament)':<18} {r['new']['accuracy']:>10.2f} {r['new']['top1']:>8.2f} {r['new']['stability']:>10.2f}")

    avg_old_acc = sum(r["old"]["accuracy"] for r in results) / len(results)
    avg_new_acc = sum(r["new"]["accuracy"] for r in results) / len(results)
    avg_old_top1 = sum(r["old"]["top1"] for r in results) / len(results)
    avg_new_top1 = sum(r["new"]["top1"] for r in results) / len(results)
    avg_old_stab = sum(r["old"]["stability"] for r in results) / len(results)
    avg_new_stab = sum(r["new"]["stability"] for r in results) / len(results)
    print("-" * 68)
    print(f"{'AVERAGE':<20} {'old (absolute)':<18} {avg_old_acc:>10.2f} {avg_old_top1:>8.2f} {avg_old_stab:>10.2f}")
    print(f"{'':<20} {'new (tournament)':<18} {avg_new_acc:>10.2f} {avg_new_top1:>8.2f} {avg_new_stab:>10.2f}")


if __name__ == "__main__":
    main()
