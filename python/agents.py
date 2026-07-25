from __future__ import annotations

"""
LuminaHire — Multi-Agent Résumé Verification Committee
=======================================================
A LangGraph state machine of four specialized agents that VERIFY A RESUME
against sources the candidate themselves supplied. It is deliberately not an
internet-research tool.

WHY (read this before changing any prompt in this file)
--------------------------------------------------------
An earlier version of this pipeline searched the open web for each
candidate. That approach is unsound for hiring, for two reasons that cannot
be prompted away:

  1. WRONG PERSON. A search for "Priya Sharma backend engineer" returns
     pages about many different people. Presenting any of it as this
     candidate's record misleads the recruiter -- strictly worse than
     returning nothing, because it looks like evidence.
  2. NOTHING TO FIND. Ordinary engineers are not public figures. Companies
     do not publish per-employee detail, so "what did they actually own at
     Acme?" has no public answer. Searching for it burns calls and invites
     the model to pad thin results.

Real recruiters don't do this either: they read the resume and click the
links on it. That is exactly what this pipeline automates -- plus the part
recruiters can't do at scale, which is systematically checking whether each
resume claim actually holds up against those links.

  1. Claims Extractor (Planner)  — reads the resume + JD and enumerates the
     candidate's CHECKABLE CLAIMS, each tagged with which candidate-supplied
     source could settle it. Plan only, no fetching.
  2. Verifier (Researcher)        — fetches ONLY candidate-supplied sources
     (resume links, and artifacts the resume names by title). Cross-checks
     the real name on each profile against the resume name so a mistyped or
     borrowed link can't contribute a stranger's data. No judgment; every
     finding carries source URLs.
  3. Claims Judge (Evaluator)     — rules each claim VERIFIED / CONTRADICTED /
     UNVERIFIABLE / UNCHECKED against the cited evidence, and scores fit.
     UNVERIFIABLE never counts against a candidate (see verification.py).
  4. Report Writer (Communicator) — WRITES the recruiter-facing report:
     narrative, red flags, hiring recommendation, and interview questions
     targeted at exactly the claims that could not be verified.

Graph:  START -(planner_output?)-> planner|researcher
        planner -> END                      (HITL pause after planning)
        researcher -> evaluator
        evaluator -(insufficient & <max)-> researcher   (agentic loop)
        evaluator -> report_writer -> END
"""

import os
import json
import operator
import time
from typing import TypedDict, List, Dict, Any, Optional, Annotated

from pydantic import BaseModel, Field
from dotenv import load_dotenv
from google import genai
from langgraph.graph import StateGraph, START, END

import tools
import llm_client
import registry
import tracing
import verification

# Load env variables from parent directory
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

MODEL = "gemini-2.5-flash"
MAX_RESEARCH_ITERATIONS = 3            # 1 initial pass + up to 2 evaluator-requested passes
USE_MOCK_AI = os.getenv("MOCK_AI_RESPONSES", "1") != "0"


def get_genai_client():
    if USE_MOCK_AI:
        return None
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise ValueError("GEMINI_API_KEY is not set in env variables!")
    return genai.Client()


def _skill_hints_from_job(job: JobDetails) -> List[str]:
    text = " ".join(filter(None, [job["title"], job["description"], job.get("requirements")]))
    lowered = text.lower()
    skills: List[str] = []
    candidates = [
        ("C systems programming", ["c ", "c,", "c.", "c systems", "kernel", "systems"]),
        ("OS internals", ["os internals", "operating system", "kernel", "systems"]),
        ("performance optimization", ["performance", "latency", "throughput", "optimization"]),
        ("distributed systems", ["distributed", "scalable", "scale", "high availability"]),
        ("backend engineering", ["backend", "api", "services", "microservices"]),
        ("public open-source work", ["open-source", "github", "public work", "contributions"]),
        ("python", ["python"]),
        ("typescript", ["typescript", "react", "next.js", "frontend", "web"]),
    ]
    for label, needles in candidates:
        if any(needle in lowered for needle in needles) and label not in skills:
            skills.append(label)
    if not skills:
        skills = ["role-relevant engineering skills", "cross-functional collaboration", "problem solving"]
    return skills[:5]


def _mock_planner_output(state: AgentState) -> Dict[str, Any]:
    candidate = state["candidate"]
    job = state["job"]
    core_skills = _skill_hints_from_job(job)
    research_plan: List[Dict[str, Any]] = []
    claims: List[Dict[str, Any]] = []

    # Mirror what the real Verifier will actually do: one plan item per
    # candidate-supplied link (matches tools.catalog.URL_TOOLS, the same table
    # the real pass's "sources this candidate provided" context is built from).
    # Nothing name-searched, and no open-web item -- mock mode must not imply a
    # capability the real pipeline deliberately does not have.
    for _tool_name, key, label, source in tools.catalog.URL_TOOLS:
        url = candidate.get(key)
        if url:
            research_plan.append({
                "heading": f"Check {label} profile",
                "explanation": f"Compare resume claims against the candidate's own {label} profile.",
                "source": source,
                "search_queries": [url],
            })
            claims.append({
                "id": f"C{len(claims) + 1}",
                "claim": f"Mock claim: the candidate's stated activity on {label} matches their resume.",
                "category": "SKILL",
                "checkable_via": source,
                "what_would_confirm": f"Profile statistics on {label} consistent with the resume.",
                "jd_relevance": "HIGH" if source == "GITHUB" else "MEDIUM",
            })

    # Always include an unverifiable claim: it's the common real-world case and
    # exercises the interview-question path downstream.
    claims.append({
        "id": f"C{len(claims) + 1}",
        "claim": f"Mock claim: professional experience relevant to {job['title']} at a previous employer.",
        "category": "EXPERIENCE",
        "checkable_via": "NONE",
        "what_would_confirm": "Nothing public — internal company work leaves no verifiable trace.",
        "jd_relevance": "HIGH",
    })

    company_vetting = {
        "companies": ["Prior employer(s) listed in resume"],
        "questions": [
            "What were the candidate's most technically demanding responsibilities?",
            "How large was the team or system the candidate worked on?",
            "What evidence is there of ownership beyond implementation work?",
        ],
    }

    return {
        "target_candidate": candidate["name"],
        "core_skills_to_verify": core_skills,
        "claims": claims,
        "research_plan": research_plan,
        "company_vetting": company_vetting,
    }


def _mock_research_results(state: AgentState, iteration: int, work_items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    candidate = state["candidate"]
    job = state["job"]
    results: List[Dict[str, Any]] = []

    # (source -> candidate URL key) for every platform that requires a known
    # URL, built from the same shared table the real ReAct pass uses, so mock
    # mode exercises exactly the same "only if a URL is known" guardrail.
    url_key_by_source = {source: key for _tool_name, key, _label, source in tools.catalog.URL_TOOLS}
    candidate_key_by_source = {source: key for _tool_name, key, _label, source in tools.catalog.CANDIDATE_TOOLS}

    for item in work_items:
        source = (item.get("source") or "WEB_SEARCH").upper()
        heading = item.get("heading", "Research item")
        query = ", ".join(item.get("search_queries") or [])

        if source in url_key_by_source:
            url = candidate.get(url_key_by_source[source])
            if url:
                results.append({
                    "heading": heading, "query": query, "source": source,
                    "findings": (
                        f"Mock scrape of the candidate's {source.title()} profile shows activity "
                        f"consistent with {job['title'].lower()} requirements."
                    ),
                    "status": "SUCCESS", "urls": [url], "iteration": iteration,
                })
            else:
                results.append({
                    "heading": heading, "query": query, "source": source,
                    "findings": f"No {source.title()} profile URL found for this candidate.",
                    "status": "NOT_FOUND", "urls": [], "iteration": iteration,
                })
            continue

        if source in candidate_key_by_source:
            key = candidate_key_by_source[source]
            url = candidate.get(key) if key else f"https://example.com/mock/{source.lower()}/{candidate['name'].lower().replace(' ', '-')}"
            results.append({
                "heading": heading, "query": query, "source": source,
                "findings": f"Mock {source.title()} search found public activity by {candidate['name']} relevant to {job['title'].lower()}.",
                "status": "SUCCESS", "urls": [url], "iteration": iteration,
            })
            continue

        results.append({
            "heading": heading,
            "query": query,
            "source": source,
            "findings": (
                f"Public references mention engineering work aligned with {job['title'].lower()}, "
                "including ownership of practical deliverables and cross-functional collaboration."
            ),
            "status": "SUCCESS",
            "urls": [f"https://example.com/mock/{candidate['name'].lower().replace(' ', '-')}"],
            "iteration": iteration,
        })

    return results


def _mock_evaluation(state: AgentState) -> Dict[str, Any]:
    candidate = state["candidate"]
    job = state["job"]
    research_results = state.get("research_results") or []
    has_github = bool(candidate.get("github_url"))
    has_linkedin = bool(candidate.get("linkedin_url"))
    fit = 84 if has_github else 77
    if has_linkedin:
        fit += 2

    planner_output = state.get("planner_output") or {}
    core_skills = planner_output.get("core_skills_to_verify", [])
    verified_skills = list(dict.fromkeys(core_skills[:3] or _skill_hints_from_job(job)[:3]))
    gaps: List[str] = []
    if not has_linkedin:
        gaps.append("LinkedIn profile was not linked, so the employment timeline could not be cross-checked.")

    if fit >= 85:
        fit = 85
    elif fit <= 0:
        fit = 70

    # Mirror the real judge's shape: claims tied to a linked profile come back
    # VERIFIED, claims marked checkable_via NONE come back UNVERIFIABLE.
    claims = planner_output.get("claims") or []
    mock_verdicts: List[Dict[str, Any]] = []
    for claim in claims:
        checkable = (claim.get("checkable_via") or "NONE").upper()
        is_checkable = checkable != "NONE"
        mock_verdicts.append({
            "id": claim.get("id", ""),
            "claim": claim.get("claim", ""),
            "status": verification.VERIFIED if is_checkable else verification.UNVERIFIABLE,
            "rationale": (
                f"Mock: the candidate's linked {checkable} profile is consistent with this claim."
                if is_checkable else
                "Mock: no source the candidate provided could settle this claim — it belongs in the interview."
            ),
            "source_url": candidate.get("github_url", "") if is_checkable else "",
            "category": claim.get("category"),
            "jd_relevance": claim.get("jd_relevance"),
        })

    return {
        "claim_verdicts": mock_verdicts,
        "claim_summary": summarize_claim_verdicts(mock_verdicts),
        "dimension_scores": {
            "skills": 90 if has_github else 80,
            "experience": 85 if has_linkedin else 78,
            "project_complexity": 88 if has_github else 75,
            "education": 72,
            "public_work": 90 if has_github else 76,
        },
        "overall_fit_percentage": fit,
        "verified_skills": verified_skills,
        "gaps_or_concerns": gaps,
        "evidence": [
            {
                "claim": f"Public code in the candidate's own repositories is relevant to {job['title']}.",
                "source_url": candidate.get("github_url") or "resume",
                "source_type": "GITHUB" if candidate.get("github_url") else "RESUME",
            },
            {
                "claim": "The candidate's linked profiles show ownership of technical projects.",
                "source_url": candidate.get("github_url") or "resume",
                "source_type": "GITHUB" if candidate.get("github_url") else "RESUME",
            },
            {
                "claim": "Employment history as stated on the resume; not publicly verifiable.",
                "source_url": candidate.get("linkedin_url") or "resume",
                "source_type": "LINKEDIN" if candidate.get("linkedin_url") else "RESUME",
            },
        ],
        "evidence_sufficient": True,
        "additional_research_requests": [],
    }


def _mock_report(state: AgentState) -> Dict[str, Any]:
    ev = state.get("evaluation") or {}
    candidate = state["candidate"]
    fit = int(ev.get("overall_fit_percentage", 80))
    if fit >= 85:
        verdict = "STRONG_MATCH"
        recommendation = "Advance to final technical interview"
    elif fit >= 70:
        verdict = "POTENTIAL_MATCH"
        recommendation = "Advance to technical interview with focused follow-up questions"
    else:
        verdict = "REJECT"
        recommendation = "Hold for now and gather more evidence"

    counts = ev.get("claim_summary") or summarize_claim_verdicts(ev.get("claim_verdicts") or [])

    # Mirror the real writer: one question per claim the verification pass
    # could not settle. This is the path that turns "we couldn't check it"
    # into something the recruiter can act on.
    questions = [
        {
            "question": f"Walk me through this in detail: {v.get('claim')}",
            "targets_claim_id": v.get("id", ""),
            "why": "Could not be verified from the candidate's public sources.",
        }
        for v in (ev.get("claim_verdicts") or [])
        if v.get("status") in verification.NON_PENALIZING_STATUSES
    ][:6]
    if not questions:
        questions = [{
            "question": "Walk us through your most technically complex project and the tradeoffs you made.",
            "targets_claim_id": "",
            "why": "General depth probe.",
        }]

    return {
        "summary": (
            f"{candidate['name']} scores {fit}% for this role. Of their resume claims, "
            f"{counts.get(verification.VERIFIED, 0)} were confirmed against their own linked profiles and "
            f"{counts.get(verification.UNVERIFIABLE, 0)} could not be checked publicly."
        ),
        "narrative": (
            f"The claims that could be checked against {candidate['name']}'s own linked profiles held up. "
            "The remainder concern work with no public footprint, which is normal — those are routed to "
            "the interview questions below rather than counted against the candidate."
        ),
        "red_flags": [],
        "interview_questions": questions,
        "hiring_recommendation": recommendation,
        "verdict": verdict,
    }


# ── State Graph Schemas ────────────────────────────────────────

class JobDetails(TypedDict):
    title: str
    description: str
    requirements: Optional[str]

class CandidateDetails(TypedDict):
    name: str
    email: str
    resume_text: Optional[str]
    linkedin_url: Optional[str]
    github_url: Optional[str]
    leetcode_url: Optional[str]
    gfg_url: Optional[str]
    codeforces_url: Optional[str]
    hackerrank_url: Optional[str]
    codechef_url: Optional[str]
    portfolio_url: Optional[str]
    medium_url: Optional[str]
    devto_url: Optional[str]
    stackoverflow_url: Optional[str]
    npm_username: Optional[str]
    scholar_url: Optional[str]

class AgentState(TypedDict):
    job: JobDetails
    candidate: CandidateDetails
    planner_output: Optional[Dict[str, Any]]
    research_results: Annotated[List[Dict[str, Any]], operator.add]  # accumulates across loop passes
    logs: Annotated[List[str], operator.add]                         # accumulates
    evaluation: Optional[Dict[str, Any]]
    final_report: Optional[Dict[str, Any]]
    research_iterations: int
    additional_requests: List[Dict[str, Any]]   # evaluator -> researcher handoff
    github_bundle: Optional[Dict[str, Any]]      # per-session GitHub cache
    hitl: bool   # True for the step-wise HITL family; pauses after researcher & evaluator
    skip_to_evaluator: bool   # explicit resume-at-evaluator signal; see route_start
    session_id: Optional[str]   # registry key for live step emission; see _emit_step


# ── Structured Output Schemas (Pydantic) ─────────────────────────

class SearchQuerySchema(BaseModel):
    heading: str = Field(description="A short, catchy title for this verification item")
    explanation: str = Field(description="What is being checked and against which candidate-supplied source")
    source: str = Field(description=(
        "The candidate-supplied source to check: GITHUB, LINKEDIN, LEETCODE, GFG, CODEFORCES, "
        "HACKERRANK, CODECHEF, PORTFOLIO, DEVTO, STACKOVERFLOW, NPM, MEDIUM, SCHOLAR, or ARXIV"
    ))
    search_queries: List[str] = Field(description="The specific URL(s) or artifact title(s) to check")


CLAIM_CATEGORIES = "SKILL, EXPERIENCE, PROJECT, METRIC, CREDENTIAL, or EDUCATION"


class ResumeClaimSchema(BaseModel):
    """
    One checkable assertion the candidate makes about themselves.

    Only `id`, `claim` and `checkable_via` are required -- they drive routing
    and the verdict matrix. The rest default, so an omitted annotation
    degrades that one field instead of failing validation for the entire
    claim set. See InterviewQuestionSchema for the incident behind this.
    """
    id: str = Field(description="Short stable identifier for this claim, e.g. 'C1', 'C2'")
    claim: str = Field(description="The specific claim, stated concisely in the candidate's own terms (e.g. 'Built a real-time chat app with WebSockets and Redis')")
    category: str = Field(default="SKILL", description=f"One of: {CLAIM_CATEGORIES}")
    checkable_via: str = Field(description=(
        "Which candidate-supplied source(s) could settle this claim: GITHUB, LEETCODE, GFG, CODEFORCES, "
        "HACKERRANK, CODECHEF, PORTFOLIO, DEVTO, STACKOVERFLOW, NPM, MEDIUM, SCHOLAR, ARXIV, LINKEDIN, "
        "or NONE when no public source the candidate provided could confirm it (internal/proprietary work, "
        "team contributions, soft skills). NONE is a perfectly normal and very common answer. "
        "If the claim spans several platforms (e.g. 'solved 1000+ problems across LeetCode and "
        "GeeksforGeeks'), list EVERY relevant source comma-separated, e.g. 'LEETCODE, GFG' -- naming only "
        "one would let it be judged against partial totals and wrongly look contradicted."
    ))
    what_would_confirm: str = Field(default="", description="Concretely, what evidence in that source would confirm or refute this claim (e.g. 'a public repo using socket.io and a Redis client')")
    jd_relevance: str = Field(default="MEDIUM", description="HIGH, MEDIUM, or LOW — how much this claim matters for THIS job description")


class ReferenceCheckSchema(BaseModel):
    """Employment history is not publicly verifiable; it is surfaced for offline reference checks instead."""
    companies: List[str] = Field(default_factory=list, description="Employers named in the resume, as written")
    questions: List[str] = Field(default_factory=list, description=(
        "Questions a recruiter should ask in a REFERENCE CHECK or interview to confirm the employment "
        "claims — these are for a human to ask a human, NOT web searches. Focus on scope, ownership, and "
        "the specific contributions the resume claims."
    ))


class PlannerOutputSchema(BaseModel):
    target_candidate: str = Field(description="Name of the candidate being vetted")
    core_skills_to_verify: List[str] = Field(description="Key technical requirements/skills from the JD to check the resume against")
    claims: List[ResumeClaimSchema] = Field(description="The candidate's checkable resume claims, most job-relevant first")
    research_plan: List[SearchQuerySchema] = Field(description="Which candidate-supplied sources will be checked, and what each is expected to settle")
    company_vetting: ReferenceCheckSchema = Field(description="Employment claims to confirm offline via reference check")

class DimensionScoresSchema(BaseModel):
    skills: int = Field(description="0-100: how well verified skills match the JD requirements")
    experience: int = Field(description="0-100: relevance and depth of professional experience")
    project_complexity: int = Field(description="0-100: sophistication of public/described projects")
    education: int = Field(description="0-100: relevance of educational background")
    public_work: int = Field(description="0-100: quality and volume of public work (repos, contributions, writing)")

class EvidenceItemSchema(BaseModel):
    claim: str = Field(description="A factual claim about the candidate")
    source_url: str = Field(description="URL supporting the claim; use 'resume' if it comes only from the resume text")
    source_type: str = Field(description="GITHUB, LINKEDIN, LEETCODE, GFG, PORTFOLIO, or RESUME")


class ClaimVerdictSchema(BaseModel):
    """The ruling on one resume claim. This is the product's core output."""
    id: str = Field(description="The claim id from the Claims Extractor, e.g. 'C1'")
    claim: str = Field(description="The claim being ruled on")
    status: str = Field(description=(
        "VERIFIED (a candidate-supplied source directly supports it), "
        "CONTRADICTED (a candidate-supplied source directly conflicts with it), "
        "UNVERIFIABLE (no source the candidate provided could settle it — the NORMAL case for internal, "
        "proprietary, or team work; this is NOT a negative signal and must not lower the score), or "
        "UNCHECKED (a relevant source existed but could not be read this run — blocked scraper, site down)."
    ))
    rationale: str = Field(default="", description="One sentence: what specifically in the evidence supports this ruling")
    source_url: str = Field(default="", description="The URL of the evidence used, or empty string when the status is UNVERIFIABLE")
    # Numeric claims are settled by arithmetic in Python, not by the model's
    # own comparison. Asking one call to both extract the figures AND label the
    # outcome reliably produced rationales like "1113 >= 1000 -> VERIFIED"
    # sitting on a status of CONTRADICTED. Extraction is what models are good
    # at; the >= comparison is what code is good at. See _apply_numeric_guard.
    claimed_value: Optional[float] = Field(default=None, description=(
        "For a numeric claim ONLY: the threshold the resume states, as a bare number. "
        "'750+ problems' -> 750. '10x improvement' -> 10. Null for non-numeric claims."
    ))
    observed_value: Optional[float] = Field(default=None, description=(
        "For a numeric claim ONLY: the actual total observed in the evidence, summed across EVERY "
        "relevant source. LeetCode 817 + GeeksforGeeks 296 -> 1113. Null if not observed or non-numeric."
    ))


class EvaluatorOutputSchema(BaseModel):
    claim_verdicts: List[ClaimVerdictSchema] = Field(description="A ruling for EVERY claim the Claims Extractor identified — no claim may be omitted")
    dimension_scores: DimensionScoresSchema
    overall_fit_percentage: int = Field(description="Calibrated overall fit score (0 to 100), based on job fit and the verification picture")
    verified_skills: List[str] = Field(description="Skills confirmed by cited evidence from a candidate-supplied source (not resume-only claims)")
    gaps_or_concerns: List[str] = Field(description="Genuine gaps against the JD, plus any CONTRADICTED claims. Never list a claim merely for being UNVERIFIABLE.")
    evidence: List[EvidenceItemSchema] = Field(description="Key claims paired with their supporting source URLs")
    evidence_sufficient: bool = Field(description="False ONLY if an unchecked candidate-supplied source could still settle a HIGH-relevance claim")
    additional_research_requests: List[SearchQuerySchema] = Field(
        description="If evidence is insufficient, targeted re-checks of candidate-supplied sources; otherwise empty"
    )

class QAAnswerSchema(BaseModel):
    answer: str = Field(description="Direct answer grounded only in the supplied context")
    citations: List[str] = Field(description="Source URLs from the research evidence that support the answer, if any")


class PairwiseComparisonSchema(BaseModel):
    winner: str = Field(description="Which candidate is the stronger fit for this role: exactly 'A' or 'B'")
    confidence: int = Field(description="0-100: how confident this judgment is, given the evidence available for both candidates")
    rationale: str = Field(description="1-2 sentence justification citing specific evidence from both candidates, not just their numeric scores")


class InterviewQuestionSchema(BaseModel):
    """
    Only `question` is required. The other two are useful annotations, not
    load-bearing data -- and making them required meant a model that omitted
    `why` on a few questions failed validation for the WHOLE report, throwing
    away a complete, correct set of claim rulings over a missing explanatory
    sentence. Never let an optional annotation be able to discard the payload.
    """
    question: str = Field(description="A specific question for the interviewer to ask")
    targets_claim_id: str = Field(default="", description="The claim id this question probes (e.g. 'C3'), or empty if it targets a general JD gap")
    why: str = Field(default="", description="One line: why this needs asking — usually 'could not be verified from public sources'")


class ReportWriterOutputSchema(BaseModel):
    summary: str = Field(description="2-3 sentence executive overview: fit for the role, and how the resume held up to verification")
    narrative: str = Field(default="", description="Multi-paragraph recruiter-facing writeup of strengths, what was confirmed, and what remains open")
    red_flags: List[str] = Field(default_factory=list, description=(
        "Serious concerns a recruiter must know: CONTRADICTED claims, identity mismatches on linked profiles, "
        "or genuine JD gaps. NEVER list a claim merely because it was UNVERIFIABLE — most real work is not "
        "publicly visible, and flagging that as a concern would punish candidates for having private jobs."
    ))
    interview_questions: List[InterviewQuestionSchema] = Field(default_factory=list, description=(
        "The deliverable that turns unverified claims into value: one targeted question per significant "
        "UNVERIFIABLE or CONTRADICTED claim, so the interviewer can settle in person what the internet could not."
    ))
    hiring_recommendation: str = Field(default="", description="Actionable recommendation, e.g. 'Advance to technical interview'")
    verdict: str = Field(default="POTENTIAL_MATCH", description="STRONG_MATCH, POTENTIAL_MATCH, or REJECT")


# ── Agent Nodes ───────────────────────────────────────────────

def _emit_step(state: AgentState, message: str) -> None:
    """
    Push a live step/tool-call line straight into the registry (when running
    as a background task with a session_id), so pollers see granular,
    Claude-Code-style progress in real time -- e.g. "Fetching GitHub profile
    for @torvalds..." as it happens, not just a generic spinner.

    This deliberately bypasses the state's `logs` reducer channel: LangGraph's
    stream() only yields once per node (a whole researcher_node pass can take
    10-30s across several tool calls), not per line within a node, so a
    direct registry write is the only way to surface progress *during* a
    node's execution rather than only after it returns. See registry.py's
    set_progress() for how this coexists with the node's own return value.
    """
    session_id = state.get("session_id")
    if session_id:
        registry.append_log(session_id, message)
    try:
        print(f"[Step] {message}")
    except UnicodeEncodeError:
        # Legacy console codepage (e.g. Windows cp1252) can't encode emoji --
        # the registry write above already succeeded, so just skip the print.
        pass


@tracing.observe(name="planner_node")
def planner_node(state: AgentState) -> Dict[str, Any]:
    """Claims Extractor. Enumerates the resume's checkable claims and maps each to a candidate-supplied source."""
    print("[Planner] Running Agent 1: Claims Extractor...")
    _emit_step(state, f"🧭 Claims Extractor: reading {state['candidate']['name']}'s resume for checkable claims...")
    if USE_MOCK_AI:
        planner_data = _mock_planner_output(state)
        print("[Planner] Mock claim set created.")
        return {
            "planner_output": planner_data,
            "logs": ["Claims Extractor generated a mock claim set."],
        }

    candidate = state["candidate"]
    available_links = tools.catalog.build_available_links_context(candidate)
    prompt = f"""
You are the Claims Extractor. Your job is NOT to plan internet research. It is to read this
candidate's resume and enumerate the specific, checkable CLAIMS they are making about themselves,
then note which — if any — of the sources THEY THEMSELVES provided could settle each one.

A recruiter reading this resume would click the links on it and ask "does this hold up?". You are
building the checklist for exactly that.

JOB DETAILS:
Title: {state['job']['title']}
Description: {state['job']['description']}
Requirements: {state['job']['requirements'] or "N/A"}

CANDIDATE: {candidate['name']}
Resume Text:
{candidate.get('resume_text') or "No resume uploaded."}

SOURCES THIS CANDIDATE PROVIDED (the ONLY sources that will ever be checked):
{available_links}
{f'''
RECRUITER PRIORITY INSTRUCTIONS FOR THIS BATCH -- weight these heavily when deciding which claims
matter most and how to set jd_relevance. Let them steer emphasis and ordering:
{state['job']['recruiter_instructions']}
''' if state['job'].get('recruiter_instructions') else ''}
HOW TO EXTRACT CLAIMS:
- Pull claims from what the resume actually says. Prefer specific, falsifiable statements ("built X
  using Y", "solved 500+ problems", "published paper Z", "3 years at Acme") over vague ones
  ("strong communicator", "passionate about tech") — vague claims are not checkable and not useful here.
- Quantified claims (counts, ratings, years, percentages) are the highest-value ones to list, because
  they can be directly compared against a profile and are where resume inflation shows up.
- Order claims by how much they matter for THIS job. Set jd_relevance accordingly.
- Aim for 6-12 claims. Do not pad the list.

HOW TO SET checkable_via (hard rules, not suggestions):
- Only name a source that appears with a real link in the list above. If GitHub says "not available",
  no claim may be checkable_via GITHUB.
- SCHOLAR/ARXIV are checkable ONLY when the resume names a specific paper title to look up — put that
  exact title in what_would_confirm.
- Use NONE whenever no candidate-supplied source could settle the claim. This is the CORRECT and
  EXPECTED answer for most employment and internal-project claims: private company work, team
  contributions, NDA'd systems, and internal metrics leave no public trace. Marking these NONE is not
  a failure — those claims get routed to the interview, which is where they belong.
- NEVER assume a claim can be checked by searching the web for the candidate's name. That is not a
  capability of this system, deliberately: name search cannot tell this candidate apart from anyone
  else with the same name, so it can only mislead. There is no WEB_SEARCH option.

COMPANY / EMPLOYMENT CLAIMS:
Employment history is not publicly verifiable for ordinary candidates. Do not propose ways to verify
it online. Instead, populate company_vetting with the employers named in the resume and the questions
a recruiter should ask in a REFERENCE CHECK or interview to confirm scope and ownership — human
questions for a human, not search queries.

RESEARCH PLAN:
research_plan should list, for each candidate-supplied source that will actually be checked, what that
check is expected to settle. One item per source, referencing the claims it bears on.
"""

    try:
        planner_data = llm_client.structured_generate(prompt, PlannerOutputSchema, temperature=0.1)
        claims = planner_data.get("claims") or []
        checkable = [c for c in claims if (c.get("checkable_via") or "NONE").upper() != "NONE"]
        print(f"[Planner] Extracted {len(claims)} claims ({len(checkable)} checkable).")
        _emit_step(
            state,
            f"✅ Claims Extractor: {len(claims)} claim(s) identified — {len(checkable)} checkable against "
            f"linked profiles, {len(claims) - len(checkable)} for the interview.",
        )
        return {
            "planner_output": planner_data,
            "logs": [f"Claims Extractor identified {len(claims)} resume claims ({len(checkable)} publicly checkable)."],
        }
    except Exception as e:
        print(f"[Planner Error] {e}")
        # Mark the failure explicitly rather than returning an empty-but-valid
        # looking plan. Without `agent_error`, a failed LLM call produced zero
        # claims, which flowed downstream into a 0% report with no verdicts --
        # indistinguishable, to a recruiter, from a candidate who checked out
        # badly. A broken run must never be mistakable for a bad candidate.
        _emit_step(state, f"❌ Claims Extractor failed: {e}")
        return {
            "planner_output": {
                "target_candidate": state['candidate']['name'],
                "core_skills_to_verify": [],
                "claims": [],
                "research_plan": [],
                "company_vetting": {"companies": [], "questions": []},
                "agent_error": f"Claims Extractor failed: {e}",
            },
            "logs": [f"Claims Extractor failed: {str(e)}"],
        }


def _work_items_from_plan(planner_output: Dict[str, Any]) -> List[Dict[str, Any]]:
    """
    Flatten a planner_output into an ordered list of verification work items.

    company_vetting deliberately does NOT contribute work items any more. Those
    questions are reference-check prompts for a human to ask, not things this
    pipeline can look up -- the old version turned each one into an open-web
    search for "<candidate name> <company>", which is precisely the
    wrong-person, nothing-to-find failure mode described in the module
    docstring. They now flow to the report instead, under interview questions.
    """
    return list(planner_output.get("research_plan") or [])


@tracing.observe(name="researcher_node")
def researcher_node(state: AgentState) -> Dict[str, Any]:
    """
    Verifier. Pure tool executor over CANDIDATE-SUPPLIED sources only.

    Two steps, in this order:
      1. Deterministic: fetch every platform the candidate gave a link for,
         and cross-check the real name on each profile against the resume name.
      2. LLM-judged: a deliberately narrow set of remaining decisions --
         which claimed technology to test against their own repos, and which
         named publication to verify. No open-web search exists here.
    """
    iteration = state.get("research_iterations", 0) + 1
    print(f"[Researcher] Running Agent 2: Verifier (pass {iteration})...")

    additional = state.get("additional_requests") or []
    work_items = additional if additional else _work_items_from_plan(state.get("planner_output") or {})

    results: List[Dict[str, Any]] = []
    logs: List[str] = []
    identity_checks: List[Dict[str, Any]] = []

    github_bundle = state.get("github_bundle")  # unused by the dispatch below; kept as a pass-through state field

    if USE_MOCK_AI:
        _emit_step(state, f"🔎 Verifier: starting pass {iteration} ({len(work_items)} source(s) to check)...")
        results = _mock_research_results(state, iteration, work_items)
        for r in results:
            _emit_step(state, f"{'✅' if r['status'] == 'SUCCESS' else '⏭️'} {r['source'].title()}: {r['heading']} ({r['status']}).")
        logs.append(
            f"Verifier pass {iteration}: executed {len(results)} mock source checks "
            f"({'follow-up requests' if additional else 'initial plan'})."
        )
        _emit_step(state, f"✅ Verifier: pass {iteration} complete, {len(results)} finding(s) gathered.")
        return {
            "research_results": results,
            "research_iterations": iteration,
            "additional_requests": [],
            "github_bundle": github_bundle,
            "logs": logs,
        }

    # AICredits-only for now, per explicit request: no Gemini client is
    # constructed (commented out below, not deleted -- uncomment to restore).
    # tool selection now goes through tools.catalog.select_tools()'s
    # AICredits path, and web_search_tool no longer needs a Gemini client
    # either (Tavily-only while Gemini grounding is disabled).
    client = None
    # try:
    #     client = get_genai_client()
    # except Exception:
    #     client = None
    candidate = state["candidate"]
    calls_made = 0
    _emit_step(state, f"🔎 Verifier: starting pass {iteration}...")

    # Sources already covered by earlier passes this session (state's
    # research_results uses an append reducer, so on evaluator-triggered
    # follow-up passes it still holds pass 1's findings). Step 1 must skip
    # these -- without this, every follow-up pass would re-call every URL
    # tool and append duplicate GitHub/LeetCode/etc. findings.
    already_covered_sources = {(r.get("source") or "").upper() for r in (state.get("research_results") or [])}

    # Step 1 -- deterministic, unconditional: call every platform tool for
    # which the candidate has a real, resume-extracted URL. Whether a URL
    # exists is unambiguous ground truth, not a judgment call, so this never
    # goes through the LLM at all -- it's not a "fallback," it's the primary
    # path, and it IS the product: these are the links a recruiter would click.
    #
    # Each fetch is followed by an identity cross-check (see verification.py):
    # if the profile publishes a real name, it must be consistent with the
    # resume name before its data is attributed to this candidate. A mistyped
    # or borrowed link is the one way a candidate-supplied source can still
    # surface the wrong person's data, and this is where that is caught.
    for tool_name, key, label, source in tools.catalog.URL_TOOLS:
        url = candidate.get(key)
        if not url or source in already_covered_sources or calls_made >= tools.catalog.MAX_TOOL_CALLS_PER_PASS:
            continue
        calls_made += 1
        _emit_step(state, f"🔧 Checking {label}: {url}")
        output = tools.catalog.dispatch(tool_name, {"url": url}, candidate, client=None)
        urls = output.get("urls") or []
        findings_text = output.get("findings", "") or "No findings."
        status = _finding_status(output)
        if status == "UNREACHABLE":
            findings_text = (
                "[SOURCE COULD NOT BE READ THIS RUN -- this is a fetch failure, NOT a finding about the "
                f"candidate. Do not treat it as evidence for or against any claim; open {url} to check "
                f"manually.]\n\n{findings_text}"
            )

        check = tools.catalog.identity_check(output, candidate, label)
        if check:
            identity_checks.append(check)
            if check["verdict"] == verification.IDENTITY_MISMATCH:
                # Prepend, not append: this must be the first thing the
                # Evaluator reads about this finding, so it can't score the
                # stats above without seeing they may not be this person's.
                findings_text = (
                    f"[IDENTITY MISMATCH -- DO NOT ATTRIBUTE THIS DATA TO THE CANDIDATE WITHOUT MANUAL "
                    f"CONFIRMATION] {check['detail']}\n\n{findings_text}"
                )
                _emit_step(state, f"🚩 {label}: profile name \"{check['profile_name']}\" does not match {candidate['name']}.")
            elif check["verdict"] == verification.IDENTITY_PARTIAL:
                findings_text = f"[IDENTITY ONLY PARTIALLY CONFIRMED] {check['detail']}\n\n{findings_text}"
                _emit_step(state, f"⚠️ {label}: profile name \"{check['profile_name']}\" only partially matches {candidate['name']}.")
            else:
                _emit_step(state, f"🪪 {label}: identity confirmed ({check['profile_name']}).")

        results.append({
            "heading": label, "query": url, "source": source,
            "findings": findings_text, "status": status, "urls": urls, "iteration": iteration,
            "identity_check": check or None,
        })
        _emit_step(state, f"{'✅' if status == 'SUCCESS' else '⚠️' if status == 'UNREACHABLE' else '⏭️'} {label}: {status}.")

    if calls_made == 0:
        # Make the "why" visible instead of silently falling through to Step
        # 2 -- this is the single most useful diagnostic line when a
        # candidate ends up with zero platform findings: it tells you
        # whether resume URL extraction genuinely found nothing (check the
        # resume for the missing links / PDF hyperlinks) rather than leaving
        # you to guess whether a tool call failed or was skipped.
        known = [f"{label}" for name, key, label, _source in tools.catalog.URL_TOOLS if candidate.get(key)]
        if known and already_covered_sources:
            _emit_step(state, f"⏭️ Verifier: all linked profiles ({', '.join(known)}) were already checked in an earlier pass -- not re-fetching.")
        else:
            _emit_step(
                state,
                f"⏭️ Verifier: this candidate's resume links to none of the {len(tools.catalog.URL_TOOLS)} "
                "supported platforms, so there is nothing to verify against. Every claim will be reported as "
                "UNVERIFIABLE and routed to interview questions -- check the resume text/PDF hyperlinks if you "
                "expected links to be found.",
            )

    # Step 2 -- LLM-judged: only two genuinely ambiguous decisions remain.
    # Which claimed technology is worth testing against the candidate's own
    # repos, and which named publication is worth verifying. The tool roster
    # passed here is restricted to exactly these (AMBIGUOUS_OLLAMA_TOOL_
    # DECLARATIONS) so the model can't re-select an already-handled URL tool
    # -- and open-web search is not in the roster at all, by design.
    _emit_step(state, "🔎 Verifier: checking for claimed technologies and publications to test...")
    claims = (state.get("planner_output") or {}).get("claims") or []
    claims_hint = json.dumps(claims, indent=2) if claims else "(no extracted claims available)"
    plan_hint = json.dumps(work_items, indent=2) if work_items else "(no specific plan items)"
    all_covered = list(state.get("research_results") or []) + results  # prior passes + this pass's Step 1
    covered_summary = "; ".join(f"{r.get('source')} ({r.get('status')})" for r in all_covered) or "(none yet)"

    context = f"""
You are the Verifier Agent on verification pass {iteration}. You check a candidate's resume claims
against sources THE CANDIDATE THEMSELVES provided. You never search for a person by name.

JOB: {state['job']['title']}
CANDIDATE: {candidate['name']}
Resume excerpt: {(candidate.get('resume_text') or 'N/A')[:1000]}

THE CANDIDATE'S EXTRACTED CLAIMS (what you are trying to confirm or refute):
{claims_hint}

VERIFICATION PLAN:
{plan_hint}
{f'''
RECRUITER PRIORITY INSTRUCTIONS FOR THIS BATCH -- bias which technology you test and which
publication you verify toward what matters here:
{state['job']['recruiter_instructions']}
''' if state['job'].get('recruiter_instructions') else ''}
ALREADY CHECKED (every profile the candidate linked has already been fetched deterministically --
do not ask for these again, they are not in your tool list):
{covered_summary}

Only two kinds of decision are left to you:

1. get_github_topic_data — the highest-value tool available. If the candidate claims a specific
   technology or project type that matters for this job (e.g. "built a MERN stack app", "ML
   pipelines", "Kubernetes"), call this to test that claim against their OWN repositories. Only
   if GitHub was successfully checked above. Prefer the claims marked HIGH jd_relevance. You may
   call this more than once for different technologies.

2. get_scholar_papers / get_arxiv_papers — call ONLY if the resume names a specific paper or
   publication, and pass its exact title as `title`. That verifies the specific artifact and
   confirms the candidate is genuinely among its authors. Do NOT call these without a title just
   to see what a name search turns up: a name search cannot tell this candidate apart from anyone
   else with the same name, so its results are worthless as evidence and actively misleading.

If the resume claims no specific technology worth testing and names no publication, call nothing.
Calling nothing is a perfectly good outcome — claims that cannot be checked against a
candidate-supplied source are meant to become interview questions, not searches.
"""

    try:
        tool_calls = tools.catalog.select_tools(context, client=client, tool_declarations=tools.catalog.AMBIGUOUS_OLLAMA_TOOL_DECLARATIONS)
    except Exception as e:
        _emit_step(state, f"⚠️ Verifier: judgment-based tool-selection call failed ({e}); skipping this part (linked profiles above were already checked).")
        tool_calls = []

    for call in (tool_calls or []):
        name = call.get("name")
        if not name:
            continue
        if calls_made >= tools.catalog.MAX_TOOL_CALLS_PER_PASS:
            break
        args = dict(call.get("args") or {})
        source = tools.catalog.infer_source_from_tool(name)
        label = tools.catalog.get_tool_label(name)

        # Belt-and-braces: web_search_tool isn't in the roster this pass was
        # given, so the model shouldn't be able to name it -- but a model can
        # hallucinate a tool name, and silently running an open-web search for
        # a candidate would violate the one guarantee this pipeline makes.
        if name == "web_search_tool":
            _emit_step(state, "⏭️ Verifier: ignoring an open-web search request -- only candidate-supplied sources are checked.")
            continue

        calls_made += 1
        arg_str = ", ".join(f"{k}={v}" for k, v in args.items())
        _emit_step(state, f"🔧 Verifying via {label}({arg_str})...")

        output = tools.catalog.dispatch(name, args, candidate, client=client)
        urls = output.get("urls") or []
        findings_text = output.get("findings", "") or "No findings."
        status = _finding_status(output)
        results.append({
            "heading": label, "query": args.get("topic") or args.get("title") or args.get("url") or "",
            "source": source, "findings": findings_text, "status": status,
            "urls": urls, "iteration": iteration,
            "authorship_confirmed": output.get("authorship_confirmed"),
        })
        _emit_step(state, f"{'✅' if status == 'SUCCESS' else '⏭️'} {label}: {status}.")

    if calls_made == 0:
        _emit_step(state, "⏭️ Verifier: nothing to check this pass (no linked profiles, and no claimed technology or publication to test).")

    identity_summary = verification.summarize_identity_checks(identity_checks)
    if identity_summary:
        logs.append(identity_summary)

    logs.append(
        f"Verifier pass {iteration}: checked {len(results)} candidate-supplied source(s) "
        f"({'follow-up requests' if additional else 'initial plan'})."
    )
    _emit_step(state, f"✅ Verifier: pass {iteration} complete, {len(results)} finding(s) gathered.")

    return {
        "research_results": results,           # appended via reducer
        "research_iterations": iteration,      # last-write-wins
        "additional_requests": [],             # clear the handoff
        "github_bundle": github_bundle,        # cache for later passes
        "logs": logs,
    }


def _finding_status(output: Dict[str, Any]) -> str:
    """
    Classify one tool result for the Claims Judge.

    Three outcomes, and the distinction between the last two matters a lot:
      SUCCESS     -- the source was read and yielded citable evidence.
      UNREACHABLE -- the source could not be read (network failure, rate
                     limit, blocked scraper). NOT evidence of anything about
                     the candidate.
      NOT_FOUND   -- the source was read successfully and had nothing.

    Previously this was just `SUCCESS if urls else NOT_FOUND`. Because these
    tools return the profile URL as evidence even when the fetch fails, a
    total network outage came back as SUCCESS, and the Judge would score
    "Could not reach geeksforgeeks.org" as a successful verification. That is
    the worst possible failure mode for a product whose entire value is
    knowing the difference between checked and unchecked.
    """
    if output.get("error"):
        return "UNREACHABLE"
    return "SUCCESS" if (output.get("urls") or []) else "NOT_FOUND"


def _apply_numeric_guard(verdict: Dict[str, Any]) -> Dict[str, Any]:
    """
    Decide numeric claims by arithmetic instead of trusting the model's label.

    Résumé figures are thresholds ("750+", "1000+ across two sites"), so the
    only question is `observed >= claimed`. Python answers that exactly; the
    model does not, reliably. Observed in testing: a rationale reading
    "claimed floor = 1000; actual total = 1113; 1113 >= 1000 -> VERIFIED"
    attached to a status of CONTRADICTED -- correct reasoning, wrong label,
    and the candidate gets publicly accused of inflating a figure they
    actually beat. A false CONTRADICTED is the most damaging output this
    system can produce, so it is never left to a label the model chose.

    Only ever flips between VERIFIED and CONTRADICTED, and only when both
    figures are present. UNVERIFIABLE/UNCHECKED are untouched: those describe
    whether a source could be read at all, which is not an arithmetic question.
    """
    status = verdict.get("status")
    if status not in (verification.VERIFIED, verification.CONTRADICTED):
        return verdict

    claimed, observed = verdict.get("claimed_value"), verdict.get("observed_value")
    if claimed is None or observed is None:
        return verdict
    try:
        claimed, observed = float(claimed), float(observed)
    except (TypeError, ValueError):
        return verdict

    correct = verification.VERIFIED if observed >= claimed else verification.CONTRADICTED
    if correct != status:
        verdict["status"] = correct
        verdict["rationale"] = (
            f"Résumé states {claimed:g}; the candidate's linked sources show {observed:g}. "
            + (f"{observed:g} meets or exceeds {claimed:g}, so the claim holds."
               if correct == verification.VERIFIED else
               f"{observed:g} falls short of {claimed:g}.")
        )
    return verdict


def _reconcile_claim_verdicts(claims: List[Dict[str, Any]],
                               verdicts: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Return exactly one verdict per extracted claim, in the claims' own order.

    Three corrections are applied to whatever the model returned:
      - an unrecognized status is coerced to UNVERIFIABLE (never to a
        penalizing one -- a malformed label must not cost a candidate points);
      - claims the model skipped are backfilled as UNVERIFIABLE;
      - verdicts for claim ids that don't exist are dropped.
    When no claims were extracted at all (planner failure, mock mode), the
    model's verdicts are passed through as-is rather than discarded.
    """
    if not claims:
        return verdicts
    by_id = {str(v.get("id", "")).strip().upper(): v for v in verdicts if isinstance(v, dict)}
    reconciled: List[Dict[str, Any]] = []
    for claim in claims:
        claim_id = str(claim.get("id", "")).strip()
        verdict = by_id.get(claim_id.upper())
        if verdict:
            status = str(verdict.get("status", "")).strip().upper()
            reconciled.append(_apply_numeric_guard({
                "id": claim_id,
                "claim": verdict.get("claim") or claim.get("claim", ""),
                "status": status if status in verification.CLAIM_STATUSES else verification.UNVERIFIABLE,
                "rationale": verdict.get("rationale") or "",
                "source_url": verdict.get("source_url") or "",
                "claimed_value": verdict.get("claimed_value"),
                "observed_value": verdict.get("observed_value"),
                "category": claim.get("category"),
                "jd_relevance": claim.get("jd_relevance"),
            }))
        else:
            reconciled.append({
                "id": claim_id,
                "claim": claim.get("claim", ""),
                "status": verification.UNVERIFIABLE,
                "rationale": "No ruling was produced for this claim, so it is reported as unverified rather than assumed either way.",
                "source_url": "",
                "category": claim.get("category"),
                "jd_relevance": claim.get("jd_relevance"),
            })
    return reconciled


def summarize_claim_verdicts(verdicts: List[Dict[str, Any]]) -> Dict[str, int]:
    """Count verdicts by status, always returning every status key (0 when absent) so UI code needn't guard."""
    counts = {status: 0 for status in verification.CLAIM_STATUSES}
    for v in verdicts or []:
        status = str(v.get("status", "")).strip().upper()
        if status in counts:
            counts[status] += 1
    return counts


@tracing.observe(name="evaluator_node")
def evaluator_node(state: AgentState) -> Dict[str, Any]:
    """Claims Judge. Rules each resume claim against cited evidence and scores fit."""
    print("[Evaluator] Running Agent 3: Claims Judge...")
    evidence_count = len(state.get("research_results") or [])
    _emit_step(state, f"🧮 Claims Judge: ruling on resume claims against {evidence_count} checked source(s)...")
    if USE_MOCK_AI:
        eval_data = _mock_evaluation(state)
        print("[Evaluator] Mock evaluation complete.")
        _emit_step(state, f"✅ Evaluator: done (fit {eval_data.get('overall_fit_percentage')}%).")
        return {
            "evaluation": eval_data,
            "additional_requests": [],
            "logs": [
                f"Evaluator scored the candidate (fit {eval_data.get('overall_fit_percentage')}%). Evidence sufficient."
            ],
        }

    research_json = json.dumps(state.get("research_results") or [], indent=2)
    planner_output = state.get("planner_output") or {}
    core_skills = planner_output.get("core_skills_to_verify", [])
    claims = planner_output.get("claims") or []
    claims_json = json.dumps(claims, indent=2) if claims else "(no claims were extracted; rule on the resume's main assertions as you find them)"
    iteration = state.get("research_iterations", 0)

    prompt = f"""
You are the Claims Judge — an impartial adjudicator. For EVERY claim the candidate makes on their
resume, rule on whether the evidence gathered from THEIR OWN linked sources supports it.

This system deliberately never searches the open web for the candidate, because a name search cannot
distinguish them from anyone else with the same name. So the only evidence you have is from sources
the candidate themselves supplied. Judge only from that.

HOW TO RULE EACH CLAIM (claim_verdicts — one entry per claim, none omitted):
- VERIFIED: a cited source directly supports the claim. Give the source_url.
- CONTRADICTED: a cited source directly conflicts with the claim (e.g. resume says "solved 800+
  problems", the linked profile shows 200). This is the most valuable ruling you produce AND the
  most damaging to get wrong — it accuses a candidate of misrepresenting themselves. Before using
  it, you MUST clear this bar:
    (a) AGGREGATE ACROSS PLATFORMS FIRST. If the claim spans multiple sources ("1000+ across
        LeetCode and GeeksforGeeks", "10 repos across GitHub and npm"), ADD UP the figures from
        every relevant finding before comparing. Ruling a combined claim against one platform's
        number alone is a false accusation. Check every finding, not just the obvious one.
    (b) READ THRESHOLDS AS MINIMA. "750+" means at least 750; a profile showing 817 CONFIRMS it,
        it does not contradict it. Only a figure BELOW the stated floor contradicts.
    (c) NEVER contradict from missing evidence. A source not mentioning something is UNVERIFIABLE,
        never CONTRADICTED — absence of proof is not proof of absence.
    (d) NEVER contradict from a source that could not be read (see UNCHECKED below).
  If the numbers are merely close, ambiguous, or you had to assume anything to make them conflict,
  rule VERIFIED or UNVERIFIABLE instead.

  MANDATORY ARITHMETIC CHECK before writing CONTRADICTED on any numeric claim. Write out:
      claimed floor = <number the resume states>
      actual total  = <sum of the figures from EVERY relevant source>
  Then apply this rule literally: if actual total >= claimed floor, the ruling is VERIFIED.
  Only if actual total < claimed floor is it CONTRADICTED. Do not reason about it in words —
  compare the two numbers.

  Worked examples (follow these exactly):
    - Claim "1000+ across LeetCode and GeeksforGeeks"; LeetCode 817, GFG 296.
      claimed floor = 1000; actual total = 817 + 296 = 1113; 1113 >= 1000 -> VERIFIED.
      (Ruling this CONTRADICTED is a serious error: the candidate exceeded their stated figure.)
    - Claim "750+ on LeetCode"; LeetCode shows 817.
      claimed floor = 750; actual total = 817; 817 >= 750 -> VERIFIED.
    - Claim "solved 800+ problems"; the only linked profile shows 200.
      claimed floor = 800; actual total = 200; 200 < 800 -> CONTRADICTED.

  State both numbers explicitly in the rationale for every numeric ruling, AND fill in the
  claimed_value / observed_value fields (claimed_value = the resume's threshold, observed_value =
  the summed total across every relevant source). Those two fields are re-checked arithmetically
  downstream, so filling them in accurately matters more than the status label you pick.
- UNVERIFIABLE: no candidate-supplied source could settle it. THIS IS THE NORMAL, EXPECTED RULING
  for most employment and internal-project claims, and it is NOT a negative signal. Most engineers
  do their best work inside private company repos. A claim being UNVERIFIABLE tells you about the
  public visibility of the work, NOT about the candidate's honesty or ability.
- UNCHECKED: a relevant source existed but couldn't be read this run. Any finding whose status is
  UNREACHABLE, or whose text is marked [SOURCE COULD NOT BE READ THIS RUN], is a FETCH FAILURE, not
  a finding about the candidate. Never cite it as evidence for or against a claim, and never let it
  lower a score — rule the affected claims UNCHECKED and note that the recruiter should open the
  link themselves.

SCORING RULES (these are hard rules):
- NEVER lower any dimension score, and never add a gap or concern, because a claim is UNVERIFIABLE
  or UNCHECKED. Penalizing unverifiability would systematically punish candidates whose work is
  proprietary — which is most good engineers. Score those claims as neutral: judge them on the
  resume's own account, exactly as a recruiter would when reading a resume with no links at all.
- A CONTRADICTED claim IS a legitimate, serious negative. Reflect it in the scores and list it
  under gaps_or_concerns.
- VERIFIED claims are a genuine positive — they are the claims you can bank on.
- If a finding is marked [IDENTITY MISMATCH], do NOT use that source's data as evidence about this
  candidate at all, and raise it under gaps_or_concerns as a profile-link problem to resolve.
- overall_fit_percentage measures FIT FOR THIS JOB, informed by how much of the resume held up.
  A candidate with mostly UNVERIFIABLE claims who fits the JD well should still score well.
{f'''- RECRUITER PRIORITY INSTRUCTIONS are provided below (see JOB DETAILS). Weight them heavily in the
  dimension scores and the overall_fit_percentage -- treat them as the primary lens for judging fit among
  candidates who otherwise look comparable, not merely a tiebreaker. Still score STRICTLY from cited evidence;
  never invent or inflate evidence to satisfy the instructions.''' if state['job'].get('recruiter_instructions') else ''}
- Only list a skill under verified_skills if a cited source supports it. Resume-only claims are NOT verified.
- You MUST populate the evidence list. Whenever any finding has status SUCCESS, include at least 3 evidence items, each pairing a concrete claim with a supporting source_url taken from that finding's `urls` (use source_type RESUME with source_url "resume" only for claims backed solely by the resume). Never return an empty evidence list when SUCCESS findings exist.
- evidence_sufficient: set false ONLY if a candidate-supplied source that could settle a HIGH-relevance
  claim was never successfully read, AND this is not already the final allowed pass ({iteration} of
  {MAX_RESEARCH_ITERATIONS}). Do NOT set it false merely because claims are UNVERIFIABLE — re-running the
  Verifier cannot make private work public, so that would just burn a pass to reach the same answer.

JOB DETAILS:
Title: {state['job']['title']}
Description: {state['job']['description']}
Requirements: {state['job']['requirements'] or "N/A"}
Core skills to verify: {", ".join(core_skills) or "N/A"}
{f"Recruiter priority instructions: {state['job']['recruiter_instructions']}" if state['job'].get('recruiter_instructions') else ""}

CANDIDATE:
Name: {state['candidate']['name']}
Resume Text: {state['candidate']['resume_text'] or "N/A"}

THE CANDIDATE'S EXTRACTED CLAIMS (rule on every one of these):
{claims_json}

EVIDENCE GATHERED FROM THE CANDIDATE'S OWN LINKED SOURCES:
{research_json}
"""

    try:
        eval_data = llm_client.structured_generate(prompt, EvaluatorOutputSchema, temperature=0.2)

        # Guarantee a verdict for every extracted claim. The prompt says "none
        # omitted", but that's advisory -- a dropped claim would silently
        # vanish from the recruiter's matrix, which is exactly the kind of
        # quiet gap this product exists to eliminate. Anything the model
        # skipped is backfilled as UNVERIFIABLE, the neutral, non-penalizing
        # status, so a model omission can never read as a negative signal.
        eval_data["claim_verdicts"] = _reconcile_claim_verdicts(
            claims, eval_data.get("claim_verdicts") or []
        )

        # Guarantee non-empty, genuinely-sourced evidence: if the model left the
        # evidence list empty but real verification succeeded, synthesize items
        # from the actual findings' headings + URLs (factual, not fabricated).
        if not eval_data.get("evidence"):
            synth: List[Dict[str, Any]] = []
            for r in (state.get("research_results") or []):
                if r.get("status") != "SUCCESS":
                    continue
                for u in (r.get("urls") or [])[:2]:
                    url = u.get("url") if isinstance(u, dict) else u
                    if not url:
                        continue
                    synth.append({
                        "claim": r.get("heading") or "Verification finding",
                        "source_url": url,
                        "source_type": r.get("source") or "RESUME",
                    })
                    if len(synth) >= 8:
                        break
                if len(synth) >= 8:
                    break
            eval_data["evidence"] = synth

        counts = summarize_claim_verdicts(eval_data["claim_verdicts"])
        eval_data["claim_summary"] = counts

        sufficient = bool(eval_data.get("evidence_sufficient", True))
        requests_list = eval_data.get("additional_research_requests") or []
        # Only propagate follow-up requests when we're actually going to loop.
        can_loop = (not sufficient) and requests_list and iteration < MAX_RESEARCH_ITERATIONS
        print(f"[Evaluator] Done. evidence_sufficient={sufficient}, will_loop={bool(can_loop)}")
        verdict_line = (
            f"{counts[verification.VERIFIED]} verified, {counts[verification.CONTRADICTED]} contradicted, "
            f"{counts[verification.UNVERIFIABLE]} unverifiable, {counts[verification.UNCHECKED]} unchecked"
        )
        _emit_step(state, (
            f"🔁 Claims Judge: a source that could settle a key claim wasn't read, requesting {len(requests_list)} re-check(s)..."
            if can_loop else
            f"✅ Claims Judge: done (fit {eval_data.get('overall_fit_percentage')}%; claims: {verdict_line})."
        ))
        return {
            "evaluation": eval_data,
            "additional_requests": requests_list if can_loop else [],
            "logs": [
                f"Claims Judge scored the candidate (fit {eval_data.get('overall_fit_percentage')}%; {verdict_line}). "
                + (f"Requested {len(requests_list)} source re-checks." if can_loop else "Evidence sufficient.")
            ],
        }
    except Exception as e:
        print(f"[Evaluator Error] {e}")
        # Fail neutral, not negative: every claim reports as UNVERIFIABLE
        # rather than the run silently looking like the candidate checked out
        # badly. A crashed judge must never be indistinguishable from a
        # candidate whose claims didn't hold up.
        _emit_step(state, f"❌ Claims Judge failed: {e}")
        fallback_verdicts = _reconcile_claim_verdicts(claims, [])
        return {
            "evaluation": {
                "claim_verdicts": fallback_verdicts,
                "claim_summary": summarize_claim_verdicts(fallback_verdicts),
                "dimension_scores": {"skills": 0, "experience": 0, "project_complexity": 0, "education": 0, "public_work": 0},
                "overall_fit_percentage": 0,
                "verified_skills": [],
                "gaps_or_concerns": ["Evaluation failed due to an internal error; this is a system fault, not a finding about the candidate."],
                "evidence": [],
                "evidence_sufficient": True,
                "additional_research_requests": [],
                # Downstream (report writer, UI, batch ranking) must be able to
                # tell "scored 0 because the run broke" from "scored 0 on merit".
                "agent_error": f"Claims Judge failed: {e}",
            },
            "additional_requests": [],
            "logs": [f"Claims Judge failed: {str(e)}"],
        }


@tracing.observe(name="report_writer_node")
def report_writer_node(state: AgentState) -> Dict[str, Any]:
    """Pure communicator. Produces the recruiter-facing report."""
    print("[ReportWriter] Running Agent 4: Report Writer...")
    _emit_step(state, "📝 Report Writer: drafting the hiring memo and interview questions...")

    ev = state.get("evaluation") or {}
    if USE_MOCK_AI:
        rw = _mock_report(state)
        report_logs = ["Report Writer compiled the mock hiring report."]
    else:
        research_json = json.dumps(state.get("research_results") or [], indent=2)
        eval_json = json.dumps(ev, indent=2)

        reference_questions = (state.get("planner_output") or {}).get("company_vetting", {}).get("questions") or []
        prompt = f"""
You are the Report Writer. Using the claim rulings and the evidence, write a concise, professional
report for a recruiter. Be specific and reference concrete evidence.

WHAT THIS REPORT IS
This system verified the candidate's resume against sources THE CANDIDATE THEMSELVES linked. It did
not search the open web for them, because a name search cannot tell one person from another with the
same name. So the report answers two questions: how well do they fit this job, and how much of what
they claim actually holds up.

HOW TO TREAT EACH CLAIM STATUS — this is the most important instruction here:
- VERIFIED claims are what the recruiter can rely on. Lead with these.
- CONTRADICTED claims are serious. Put every one in red_flags, stating plainly what the resume says
  versus what their own profile shows.
- UNVERIFIABLE claims are NOT red flags and NOT weaknesses. Most engineering work happens in private
  company repositories and leaves no public trace, so this is the normal state of an honest resume.
  NEVER write anything like "limited public evidence", "thin public footprint", or "could not
  substantiate" as a concern. Doing so would penalize candidates for having had normal jobs.
  Instead, convert each significant one into an interview question.
- UNCHECKED claims mean a source existed but couldn't be read this run. Mention the link is worth
  opening manually; don't treat it as a negative.

INTERVIEW QUESTIONS — the core deliverable
Write one specific, probing question per significant UNVERIFIABLE or CONTRADICTED claim, setting
targets_claim_id to that claim's id. Make each question something only someone who genuinely did the
work could answer well (architecture decisions, tradeoffs, failure modes, what they'd change) — not
a yes/no or a question a bluffing candidate could deflect. This is how the recruiter settles in
person what the internet could not.
{f'''
Also fold in these employment/reference-check questions raised during claim extraction (use an empty
targets_claim_id for these):
{json.dumps(reference_questions, indent=2)}
''' if reference_questions else ''}
JOB: {state['job']['title']}
CANDIDATE: {state['candidate']['name']}

EVALUATION AND CLAIM RULINGS:
{eval_json}

EVIDENCE FROM THE CANDIDATE'S OWN LINKED SOURCES:
{research_json}
"""

        try:
            rw = llm_client.structured_generate(prompt, ReportWriterOutputSchema, temperature=0.4)
            report_logs = ["Report Writer compiled the final hiring report."]
        except Exception as e:
            print(f"[ReportWriter Error] {e}")
            _emit_step(state, f"❌ Report Writer failed: {e}")
            rw = {
                "summary": (
                    "This report could not be generated: the report-writing step failed with an internal "
                    f"error ({e}). The claim rulings and evidence below are still valid — only the written "
                    "summary is missing. Re-run the session to produce it."
                ),
                "narrative": "",
                "red_flags": [],
                "interview_questions": [],
                "hiring_recommendation": "Manual review required — automated report generation failed.",
                "verdict": "POTENTIAL_MATCH",
                "agent_error": f"Report Writer failed: {e}",
            }
            report_logs = [f"Report Writer failed: {str(e)}"]

    # Interview questions are now structured ({question, targets_claim_id,
    # why}), but the UI and the Application sync both read a plain string
    # list. Flatten for the legacy key and expose the structured form
    # alongside, so neither consumer breaks and the claim linkage isn't lost.
    raw_questions = rw.get("interview_questions") or []
    detailed_questions = [q for q in raw_questions if isinstance(q, dict)]
    flat_questions = [
        (q.get("question") or "").strip() if isinstance(q, dict) else str(q).strip()
        for q in raw_questions
    ]
    flat_questions = [q for q in flat_questions if q]

    claim_verdicts = ev.get("claim_verdicts") or []

    # Merge into the superset final_report (legacy keys preserved for the UI +
    # Application sync; new keys are additive).
    final_report = {
        # legacy keys (UI + Application sync depend on these):
        "overall_fit_percentage": ev.get("overall_fit_percentage", 0),
        "summary": rw.get("summary", ""),
        "verified_skills": ev.get("verified_skills", []),
        "gaps_or_concerns": ev.get("gaps_or_concerns", []),
        "interview_questions": flat_questions,
        "verdict": rw.get("verdict", "POTENTIAL_MATCH"),
        # extensions:
        "dimension_scores": ev.get("dimension_scores", {}),
        "evidence": ev.get("evidence", []),
        "red_flags": rw.get("red_flags", []),
        "narrative": rw.get("narrative", ""),
        "hiring_recommendation": rw.get("hiring_recommendation", ""),
        "research_iterations": state.get("research_iterations", 0),
        # claims verification (the product's core output):
        "claim_verdicts": claim_verdicts,
        "claim_summary": ev.get("claim_summary") or summarize_claim_verdicts(claim_verdicts),
        "interview_questions_detailed": detailed_questions,
    }

    # Surface any stage failure on the report itself. A recruiter looking at a
    # 0% verdict must be able to tell a broken run from a weak candidate, and
    # the report is the only artifact most of them will ever open.
    agent_errors = [
        err for err in (
            (state.get("planner_output") or {}).get("agent_error"),
            ev.get("agent_error"),
            rw.get("agent_error"),
        ) if err
    ]
    if agent_errors:
        final_report["agent_errors"] = agent_errors
        final_report["verdict"] = "INCOMPLETE"
        final_report["hiring_recommendation"] = (
            "Do not act on this report — the run did not complete. " + " ".join(agent_errors)
        )

    _emit_step(state, f"✅ Report Writer: hiring memo ready (verdict: {final_report['verdict']}).")
    return {"final_report": final_report, "logs": report_logs}


# ── Q&A over accumulated research context ──────────────────────

def _mock_qa_answer(candidate: CandidateDetails, question: str, evaluation: Optional[Dict[str, Any]],
                     research_results: Optional[List[Dict[str, Any]]]) -> Dict[str, Any]:
    citations: List[str] = []
    for item in (evaluation or {}).get("evidence") or []:
        url = item.get("source_url")
        if url and url != "resume" and url not in citations:
            citations.append(url)
        if len(citations) >= 2:
            break
    if not citations:
        for r in research_results or []:
            for u in (r.get("urls") or []):
                url = u.get("url") if isinstance(u, dict) else u
                if url and url not in citations:
                    citations.append(url)
                if len(citations) >= 2:
                    break
            if len(citations) >= 2:
                break

    return {
        "answer": (
            f"Based on the research gathered on {candidate['name']}, regarding \"{question.strip()}\": "
            "the available evidence supports the summary already produced in the final report. "
            "(Mock mode — enable real AI to get a grounded answer.)"
        ),
        "citations": citations,
    }


@tracing.observe(name="qa_node")
def answer_qa_question(job: Dict[str, Any], candidate: Dict[str, Any],
                        planner_output: Optional[Dict[str, Any]],
                        research_results: Optional[List[Dict[str, Any]]],
                        evaluation: Optional[Dict[str, Any]],
                        final_report: Optional[Dict[str, Any]],
                        question: str) -> Dict[str, Any]:
    """Answer a free-text recruiter question using only the accumulated pipeline context."""
    print(f"[QA] Answering question about {candidate.get('name')}...")
    if USE_MOCK_AI:
        return _mock_qa_answer(candidate, question, evaluation, research_results)  # type: ignore[arg-type]

    prompt = f"""
You are answering a recruiter's follow-up question about a candidate, using ONLY the context below.
Do not invent facts. If the context does not support an answer, say so explicitly. Cite source_url
values from the research evidence that support your answer (use "resume" only for resume-only claims).

JOB:
Title: {job['title']}
Description: {job['description']}
Requirements: {job.get('requirements') or "N/A"}

CANDIDATE: {candidate['name']}
Resume Text: {candidate.get('resume_text') or "N/A"}

RESEARCH PLAN:
{json.dumps(planner_output or {}, indent=2)}

RESEARCH EVIDENCE:
{json.dumps(research_results or [], indent=2)}

EVALUATION:
{json.dumps(evaluation or {}, indent=2)}

FINAL REPORT:
{json.dumps(final_report or {}, indent=2)}

QUESTION: {question}
"""

    try:
        return llm_client.structured_generate(prompt, QAAnswerSchema, temperature=0.2)
    except Exception as e:
        print(f"[QA Error] {e}")
        return {"answer": f"Failed to answer the question: {str(e)}", "citations": []}


# ── Pairwise Tournament Ranking (batch "Hiring Committee" re-ranking) ───────
"""
Each batch member's Evaluator score is produced by a fully independent LLM
call -- own context, own research evidence, own sampling variance -- so
absolute scores across candidates are not calibrated against each other and
sorting by them directly bakes in noise. This adds a re-ranking pass over a
small shortlist (the top candidates by absolute score): every pair is shown
to the LLM side by side and asked "which is the stronger fit", which is the
well-established more-reliable alternative to independent absolute scoring.
Bounded cost: round-robin over a FIXED shortlist size (not the whole pool),
each pair compared twice (presentation order swapped) to cancel position
bias -- calls = K x (K-1), independent of total pool size.
"""


def _mock_pairwise_compare(candidate_a: Dict[str, Any], candidate_b: Dict[str, Any]) -> Dict[str, Any]:
    score_a = (candidate_a.get("evaluation") or {}).get("overall_fit_percentage", 0)
    score_b = (candidate_b.get("evaluation") or {}).get("overall_fit_percentage", 0)
    winner = "A" if score_a >= score_b else "B"
    return {
        "winner": winner,
        "confidence": 60,
        "rationale": f"Mock comparison: {candidate_a['name']} ({score_a}%) vs {candidate_b['name']} ({score_b}%).",
    }


@tracing.observe(name="pairwise_compare")
def _pairwise_compare(job: Dict[str, Any], candidate_a: Dict[str, Any], candidate_b: Dict[str, Any]) -> Dict[str, Any]:
    """
    One head-to-head judgment between two already-evaluated candidates (their
    accumulated Evaluator output -- dimension scores, verified skills, gaps,
    evidence -- not raw research). Grounded strictly in that evidence; no new
    research or invented facts. `candidate_a`/`candidate_b` are shown as "A"/"B"
    in THIS call's prompt in the order passed -- callers wanting position-bias
    cancellation should call this twice with the two candidates swapped.
    """
    if USE_MOCK_AI:
        return _mock_pairwise_compare(candidate_a, candidate_b)

    prompt = f"""
You are the Hiring Committee's Ranking Judge. Two candidates have already been
independently researched and evaluated for the SAME role. Decide which is the
stronger fit for THIS specific role, based STRICTLY on the evidence below --
do not invent facts, and do not simply defer to whichever numeric score is
higher; weigh the underlying verified skills, gaps, and evidence yourself.

JOB DETAILS:
Title: {job['title']}
Description: {job['description']}
Requirements: {job.get('requirements') or "N/A"}
{f"Recruiter priority instructions: {job['recruiter_instructions']}" if job.get('recruiter_instructions') else ""}

CANDIDATE A: {candidate_a['name']}
{json.dumps(candidate_a.get('evaluation') or {}, indent=2)}

CANDIDATE B: {candidate_b['name']}
{json.dumps(candidate_b.get('evaluation') or {}, indent=2)}

Which candidate -- A or B -- is the stronger fit for this specific role?
"""
    return llm_client.structured_generate(prompt, PairwiseComparisonSchema, temperature=0.1)


def _pairwise_compare_safe(job: Dict[str, Any], candidate_a: Dict[str, Any], candidate_b: Dict[str, Any]) -> Dict[str, Any]:
    """Never let one failed comparison call crash the whole tournament -- degrade to a tie-shaped result instead."""
    try:
        return _pairwise_compare(job, candidate_a, candidate_b)
    except Exception as e:
        print(f"[PairwiseCompare Error] {e}")
        return {"winner": "A", "confidence": 0, "rationale": f"Comparison call failed: {e}", "_error": True}


@tracing.observe(name="pairwise_tournament")
def run_pairwise_tournament(job: Dict[str, Any], shortlist: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Round-robin re-ranking over a small shortlist of already-evaluated batch
    members. shortlist: [{"session_id", "name", "evaluation", "overall_fit_percentage"}, ...]

    Every pair is compared TWICE with swapped presentation order to cancel
    position bias; if the two calls disagree on the winner, it's scored as a
    tie (0.5 win each) rather than paying for a third, tie-breaking call.
    Final order = Copeland ranking (win count descending), ties broken by each
    candidate's own overall_fit_percentage. Returns winner-first session_id
    order plus a per-candidate {wins, matches} detail for the recruiter UI.
    """
    n = len(shortlist)
    wins: Dict[str, float] = {c["session_id"]: 0.0 for c in shortlist}
    matches: Dict[str, List[Dict[str, Any]]] = {c["session_id"]: [] for c in shortlist}

    for i in range(n):
        for j in range(i + 1, n):
            a, b = shortlist[i], shortlist[j]
            result_ab = _pairwise_compare_safe(job, a, b)  # a shown as "A", b as "B"
            result_ba = _pairwise_compare_safe(job, b, a)  # b shown as "A", a as "B" (swapped)

            winner_ab = a["session_id"] if result_ab.get("winner") == "A" else b["session_id"]
            winner_ba = b["session_id"] if result_ba.get("winner") == "A" else a["session_id"]

            if winner_ab == winner_ba:
                wins[winner_ab] += 1.0
                outcome = winner_ab
            else:
                wins[a["session_id"]] += 0.5
                wins[b["session_id"]] += 0.5
                outcome = "tie"

            matches[a["session_id"]].append({
                "opponent": b["session_id"], "opponent_name": b["name"], "outcome": outcome,
                "rationale": result_ab.get("rationale"),
            })
            matches[b["session_id"]].append({
                "opponent": a["session_id"], "opponent_name": a["name"], "outcome": outcome,
                "rationale": result_ba.get("rationale"),
            })

    ranked = sorted(shortlist, key=lambda c: (-wins[c["session_id"]], -(c.get("overall_fit_percentage") or 0)))
    ranking = [c["session_id"] for c in ranked]
    details = {
        c["session_id"]: {
            "name": c["name"],
            "wins": wins[c["session_id"]],
            "matches_played": n - 1,
            "matches": matches[c["session_id"]],
        }
        for c in shortlist
    }
    return {"ranking": ranking, "details": details}


# ── Build the LangGraph Workflow ───────────────────────────────

workflow = StateGraph(AgentState)

workflow.add_node("planner", planner_node)
workflow.add_node("researcher", researcher_node)
workflow.add_node("evaluator", evaluator_node)
workflow.add_node("report_writer", report_writer_node)


def route_start(state: AgentState):
    # Resume-aware entry, driven by the explicit skip_to_evaluator flag (NOT by
    # research_results truthiness -- an approved-but-empty research pass is a
    # real, valid state, and an empty list is falsy in Python, which would
    # otherwise send an explicitly-approved empty research pass back through
    # the researcher instead of on to evaluation):
    #  - skip_to_evaluator=True  -> jump straight to evaluation (research already gathered/approved)
    #  - plan exists, no skip    -> start researching
    #  - nothing yet             -> plan first
    if state.get("skip_to_evaluator"):
        return "evaluator"
    if state.get("planner_output"):
        return "researcher"
    return "planner"


def route_after_researcher(state: AgentState):
    # HITL pause after the first, plan-driven research pass only. Evaluator-
    # triggered follow-up passes (research_iterations > 1) happen inside an
    # already-approved EVALUATING phase and must not re-pause. Non-HITL callers
    # (hitl=False, e.g. run-full-async) always fall through unchanged.
    if state.get("hitl") and state.get("research_iterations", 0) <= 1:
        return "end"
    return "evaluator"


def route_after_evaluation(state: AgentState):
    ev = state.get("evaluation") or {}
    if (not ev.get("evidence_sufficient", True)
            and state.get("additional_requests")
            and state.get("research_iterations", 0) < MAX_RESEARCH_ITERATIONS):
        return "researcher"
    if state.get("hitl"):
        return "end"
    return "report_writer"


workflow.add_conditional_edges(
    START, route_start,
    {"planner": "planner", "researcher": "researcher", "evaluator": "evaluator"},
)
workflow.add_edge("planner", END)  # HITL pause after planning
workflow.add_conditional_edges(
    "researcher", route_after_researcher,
    {"evaluator": "evaluator", "end": END},
)
workflow.add_conditional_edges(
    "evaluator", route_after_evaluation,
    {"researcher": "researcher", "report_writer": "report_writer", "end": END},
)
workflow.add_edge("report_writer", END)

app_graph = workflow.compile()


def new_state(job: Dict[str, Any], candidate: Dict[str, Any],
              planner_output: Optional[Dict[str, Any]] = None,
              research_results: Optional[List[Dict[str, Any]]] = None,
              research_iterations: int = 0,
              hitl: bool = False,
              evaluation: Optional[Dict[str, Any]] = None,
              skip_to_evaluator: bool = False,
              session_id: Optional[str] = None) -> AgentState:
    """
    Build a correctly-initialized state (reducer channels as lists). Passing
    research_results (from a persisted, interrupted run) lets the graph resume at
    the evaluator and skip re-running the expensive research stage. Passing
    evaluation seeds an already-approved evaluation for a report-writer-only
    invocation (bypasses the graph entirely; see main.py's _run_report_stage).
    session_id (when running as a background task) lets nodes emit live,
    per-step progress straight into the registry; see _emit_step.
    """
    return {
        "job": job,
        "candidate": candidate,
        "planner_output": planner_output,
        "research_results": list(research_results) if research_results else [],
        "logs": [],
        "evaluation": evaluation,
        "final_report": None,
        "research_iterations": research_iterations,
        "additional_requests": [],
        "github_bundle": None,
        "hitl": hitl,
        "skip_to_evaluator": skip_to_evaluator,
        "session_id": session_id,
    }


# ── Self-testing execution ─────────────────────────────────────
if __name__ == "__main__":
    print("Testing full Hiring Committee pipeline...")

    state = new_state(
        job={
            "title": "Senior Systems Engineer",
            "description": "Deep C systems programming, OS internals, performance work.",
            "requirements": "Expert C, OS internals, large-scale open-source contributions",
        },
        candidate={
            "name": "Linus Torvalds",
            "email": "linus@example.com",
            "resume_text": "Creator of Linux and Git. Decades of C systems programming.",
            "linkedin_url": None,
            "github_url": "https://github.com/torvalds",
        },
    )

    print("\n--- STAGE 1: PLANNER ---")
    stage1 = app_graph.invoke(state)
    print(json.dumps(stage1.get("planner_output"), indent=2)[:800])

    print("\n--- STAGE 2: FULL PIPELINE (research -> evaluate -> report) ---")
    final = app_graph.invoke(stage1)
    print("\nFINAL REPORT:")
    print(json.dumps(final.get("final_report"), indent=2)[:1500])
    print("\nRESEARCH ITERATIONS:", final.get("research_iterations"))
    print("\nLOGS:")
    for line in final.get("logs", []):
        print(" -", line)
