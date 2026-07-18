from __future__ import annotations

"""
LuminaHire — Multi-Agent Hiring Committee
=========================================
A LangGraph state machine of four specialized agents, each with a distinct,
non-overlapping capability:

  1. Planner (Lead Recruiter)  — decides WHAT to verify. Plan only.
  2. Researcher (Tool Executor) — GATHERS real evidence via GitHub REST + Gemini
     Google Search grounding. No judgment; every finding carries source URLs.
  3. Evaluator (Judge)          — SCORES the candidate per dimension against the
     cited evidence, and may declare the evidence insufficient and request more
     research (conditional loop back to the Researcher, bounded).
  4. Report Writer (Communicator) — WRITES the recruiter-facing report: narrative,
     red flags, hiring recommendation, tailored interview questions.

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

# Load env variables from parent directory
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

MODEL = "gemini-2.5-flash"
MAX_RESEARCH_ITERATIONS = 3            # 1 initial pass + up to 2 evaluator-requested passes
MAX_GROUNDED_CALLS_PER_PASS = 2        # matches the "at most 2" guidance given to the model -- non-public candidates rarely have web-searchable narrative detail, so a low cap keeps calls from being wasted chasing unanswerable questions
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

    # Mirror what the real ReAct researcher would see: one plan item per
    # platform the candidate actually has a link for (matches
    # tools.catalog.URL_TOOLS, the same table the real pass's "Available
    # profile links" context is built from), plus the always-searchable
    # name-matched tools (Scholar/arXiv), plus a generic WEB_SEARCH item.
    for _tool_name, key, label, source in tools.catalog.URL_TOOLS:
        url = candidate.get(key)
        if url:
            research_plan.append({
                "heading": f"Review {label} profile",
                "explanation": f"Check activity and track record on {label}.",
                "source": source,
                "search_queries": [url],
            })

    for _tool_name, key, label, source in tools.catalog.CANDIDATE_TOOLS:
        if key is None or candidate.get(key):
            research_plan.append({
                "heading": f"Search {label}",
                "explanation": f"Look for the candidate's presence on {label}.",
                "source": source,
                "search_queries": [candidate["name"]],
            })

    research_plan.append({
        "heading": "Verify public engineering evidence",
        "explanation": "Confirm public mentions of technical ownership, scope, and project complexity.",
        "source": "WEB_SEARCH",
        "search_queries": [
            f"{candidate['name']} engineering background",
            f"{candidate['name']} public projects",
        ],
    })

    company_vetting = {
        "companies": ["Prior employer(s) listed in resume or public profile"],
        "questions": [
            "What were the candidate's most technically demanding responsibilities?",
            "How large was the team or system the candidate worked on?",
            "What evidence is there of ownership beyond implementation work?",
        ],
    }

    return {
        "target_candidate": candidate["name"],
        "core_skills_to_verify": core_skills,
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

    core_skills = (state.get("planner_output") or {}).get("core_skills_to_verify", [])
    verified_skills = list(dict.fromkeys(core_skills[:3] or _skill_hints_from_job(job)[:3]))
    gaps: List[str] = []
    if not has_linkedin:
        gaps.append("LinkedIn profile was not available for timeline verification.")
    if len(research_results) < 2:
        gaps.append("Public evidence set is smaller than ideal for a final hiring decision.")

    if fit >= 85:
        fit = 85
    elif fit <= 0:
        fit = 70

    return {
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
                "claim": f"Public code demonstrates applied engineering work relevant to {job['title']}.",
                "source_url": candidate.get("github_url") or "resume",
                "source_type": "GITHUB" if candidate.get("github_url") else "RESUME",
            },
            {
                "claim": "Research notes indicate ownership of technical projects and public work.",
                "source_url": candidate.get("github_url") or "resume",
                "source_type": "GITHUB" if candidate.get("github_url") else "RESUME",
            },
            {
                "claim": "Profile-level evidence supports senior engineering experience.",
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

    return {
        "summary": (
            f"{candidate['name']} appears to be a credible candidate with strong public engineering signals "
            f"and a fit score of {fit}% for the role."
        ),
        "narrative": (
            f"The available evidence suggests {candidate['name']} has relevant technical depth, "
            "particularly in public work and practical execution. The candidate looks aligned with the role "
            "and should be moved forward for a deeper interview loop."
        ),
        "red_flags": [],
        "interview_questions": [
            "Walk us through your most technically complex public project and the tradeoffs you made.",
            "Which parts of the stack did you own end-to-end, and how did you measure success?",
            "What is one engineering decision you would revisit today, and why?",
        ],
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
    heading: str = Field(description="A short, catchy title for this research item")
    explanation: str = Field(description="Detailed explanation of why this is being searched and what the goal is")
    source: str = Field(description=(
        "The source to search: GITHUB, LINKEDIN, LEETCODE, GFG, CODEFORCES, HACKERRANK, "
        "CODECHEF, PORTFOLIO, or WEB_SEARCH"
    ))
    search_queries: List[str] = Field(description="List of 2-3 target search queries")

class CompanyVettingSchema(BaseModel):
    companies: List[str] = Field(description="List of candidate's past companies mentioned in their resume to research")
    questions: List[str] = Field(
        description=(
            "At most one broad, checkable question per company (e.g. 'does this company exist and is the "
            "claimed role plausible?') -- NOT multiple narrative sub-questions about specific role/scope/"
            "technologies/contributions, since most candidates aren't public figures and generic web search "
            "cannot answer per-employee narrative detail for a private individual."
        )
    )

class PlannerOutputSchema(BaseModel):
    target_candidate: str = Field(description="Name of the candidate being vetted")
    core_skills_to_verify: List[str] = Field(description="List of key technical requirements/skills from the JD to evaluate")
    research_plan: List[SearchQuerySchema] = Field(description="List of specific search operations to perform")
    company_vetting: CompanyVettingSchema = Field(description="Vetting plan for past companies")

class DimensionScoresSchema(BaseModel):
    skills: int = Field(description="0-100: how well verified skills match the JD requirements")
    experience: int = Field(description="0-100: relevance and depth of professional experience")
    project_complexity: int = Field(description="0-100: sophistication of public/described projects")
    education: int = Field(description="0-100: relevance of educational background")
    public_work: int = Field(description="0-100: quality and volume of public work (repos, contributions, writing)")

class EvidenceItemSchema(BaseModel):
    claim: str = Field(description="A factual claim about the candidate")
    source_url: str = Field(description="URL supporting the claim; use 'resume' if it comes only from the resume text")
    source_type: str = Field(description="GITHUB, WEB_SEARCH, LINKEDIN, or RESUME")

class EvaluatorOutputSchema(BaseModel):
    dimension_scores: DimensionScoresSchema
    overall_fit_percentage: int = Field(description="Calibrated overall fit score (0 to 100)")
    verified_skills: List[str] = Field(description="Skills confirmed by cited research evidence (not resume-only claims)")
    gaps_or_concerns: List[str] = Field(description="Missing requirements or concerns identified")
    evidence: List[EvidenceItemSchema] = Field(description="Key claims paired with their supporting source URLs")
    evidence_sufficient: bool = Field(description="False if more research is needed to reach a confident verdict")
    additional_research_requests: List[SearchQuerySchema] = Field(
        description="If evidence is insufficient, as many targeted follow-up research items as are genuinely needed to reach a confident verdict; otherwise empty"
    )

class QAAnswerSchema(BaseModel):
    answer: str = Field(description="Direct answer grounded only in the supplied context")
    citations: List[str] = Field(description="Source URLs from the research evidence that support the answer, if any")


class ReportWriterOutputSchema(BaseModel):
    summary: str = Field(description="2-3 sentence executive overview of the candidate's fit")
    narrative: str = Field(description="Multi-paragraph recruiter-facing writeup of strengths, evidence, and fit")
    red_flags: List[str] = Field(description="Serious concerns or inconsistencies a recruiter must know (empty if none)")
    interview_questions: List[str] = Field(description="Personalized questions targeting gaps and verifying strengths")
    hiring_recommendation: str = Field(description="Actionable recommendation, e.g. 'Advance to technical interview'")
    verdict: str = Field(description="STRONG_MATCH, POTENTIAL_MATCH, or REJECT")


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


def planner_node(state: AgentState) -> Dict[str, Any]:
    print("[Planner] Running Agent 1: Lead Recruiter (Planner)...")
    _emit_step(state, f"🧭 Planner: analyzing job requirements and {state['candidate']['name']}'s resume...")
    if USE_MOCK_AI:
        planner_data = _mock_planner_output(state)
        print("[Planner] Mock research plan created.")
        return {
            "planner_output": planner_data,
            "logs": ["Planner Agent generated a mock research plan."],
        }

    candidate = state["candidate"]
    prompt = f"""
You are the Lead Recruiter (Planner) Agent. Analyze the Job Description and the Candidate's Resume to determine what additional context and vetting is needed.
Determine which key skills need verification, what research queries should be run on public platforms, and what questions should be investigated regarding their past companies.

JOB DETAILS:
Title: {state['job']['title']}
Description: {state['job']['description']}
Requirements: {state['job']['requirements'] or "N/A"}

CANDIDATE DETAILS:
Name: {candidate['name']}
Resume Text: {candidate.get('resume_text') or "No resume uploaded."}
LinkedIn URL: {candidate.get('linkedin_url') or "Not provided"}
GitHub URL: {candidate.get('github_url') or "Not provided"}
LeetCode URL: {candidate.get('leetcode_url') or "Not provided"}
GeeksforGeeks URL: {candidate.get('gfg_url') or "Not provided"}
Codeforces URL: {candidate.get('codeforces_url') or "Not provided"}
HackerRank URL: {candidate.get('hackerrank_url') or "Not provided"}
CodeChef URL: {candidate.get('codechef_url') or "Not provided"}
Portfolio website URL: {candidate.get('portfolio_url') or "Not provided"}
{f'''
RECRUITER PRIORITY INSTRUCTIONS FOR THIS BATCH -- weight these heavily when choosing which core
skills to verify and when designing the research plan. Do not ignore the job description/requirements,
but let these steer the emphasis, ordering, and which platforms/skills you prioritize verifying:
{state['job']['recruiter_instructions']}
''' if state['job'].get('recruiter_instructions') else ''}
Create a highly targeted vetting plan. Be concrete.

IMPORTANT constraints on sources (these are hard rules, not suggestions):
- GITHUB, LEETCODE, GFG, CODEFORCES, HACKERRANK, CODECHEF, and PORTFOLIO items can ONLY be included when the
  matching URL above is provided -- these are looked up directly from that URL, never searched for by name.
  Do not include one of these sources if its URL says "Not provided".
- LINKEDIN works the same way: LinkedIn cannot be searched or scraped (it blocks this), so only include a
  LINKEDIN item when a LinkedIn URL is provided above; it will simply be cited as evidence, not searched.
- WEB_SEARCH is the only source that can be used without a specific URL (general web presence, articles,
  technical writing, etc.). Most candidates are NOT public figures, so generic web search cannot answer
  narrative questions about their specific role/scope/contributions at a past company -- companies don't
  publish per-employee detail. Only propose WEB_SEARCH company-vetting items to check that a company plausibly
  exists, not to fish for narrative role detail; keep it to at most one broad item per company.
"""

    try:
        planner_data = llm_client.structured_generate(prompt, PlannerOutputSchema, temperature=0.1)
        print("[Planner] Research plan created.")
        plan_len = len(planner_data.get("research_plan") or [])
        _emit_step(state, f"✅ Planner: research plan ready ({plan_len} item(s) to investigate).")
        return {
            "planner_output": planner_data,
            "logs": ["Planner Agent generated the research plan."],
        }
    except Exception as e:
        print(f"[Planner Error] {e}")
        return {
            "planner_output": {
                "target_candidate": state['candidate']['name'],
                "core_skills_to_verify": [],
                "research_plan": [],
                "company_vetting": {"companies": [], "questions": []},
            },
            "logs": [f"Planner Agent failed: {str(e)}"],
        }


def _work_items_from_plan(planner_output: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Flatten a planner_output into an ordered list of research work items."""
    items: List[Dict[str, Any]] = list(planner_output.get("research_plan") or [])
    company = planner_output.get("company_vetting") or {}
    for q in (company.get("questions") or []):
        items.append({
            "heading": "Company/Role verification",
            "explanation": "Verify past company role and scope.",
            "source": "WEB_SEARCH",
            "search_queries": [q],
        })
    return items


def researcher_node(state: AgentState) -> Dict[str, Any]:
    """Pure tool executor. Runs the plan (or the evaluator's follow-up requests)."""
    iteration = state.get("research_iterations", 0) + 1
    print(f"[Researcher] Running Agent 2: Technical Researcher (pass {iteration})...")

    additional = state.get("additional_requests") or []
    work_items = additional if additional else _work_items_from_plan(state.get("planner_output") or {})

    results: List[Dict[str, Any]] = []
    logs: List[str] = []
    grounded_calls = 0

    github_bundle = state.get("github_bundle")  # unused by the ReAct dispatch below; kept as a pass-through state field

    if USE_MOCK_AI:
        _emit_step(state, f"🔎 Researcher: starting pass {iteration} ({len(work_items)} item(s) to investigate)...")
        results = _mock_research_results(state, iteration, work_items)
        for r in results:
            _emit_step(state, f"{'✅' if r['status'] == 'SUCCESS' else '⏭️'} {r['source'].title()}: {r['heading']} ({r['status']}).")
        logs.append(
            f"Researcher pass {iteration}: executed {len(results)} mock lookups "
            f"({'follow-up requests' if additional else 'initial plan'})."
        )
        _emit_step(state, f"✅ Researcher: pass {iteration} complete, {len(results)} finding(s) gathered.")
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
    _emit_step(state, f"🔎 Researcher: starting pass {iteration}...")

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
    # path. This guarantees every platform the resume/planner points to
    # actually gets researched, instead of leaving it up to a tool-selecting
    # LLM's discretion (smaller/cheaper models especially tend to reach for
    # the generic web_search_tool instead of a specific platform tool, even
    # when a real link is available and explicitly listed).
    for tool_name, key, label, source in tools.catalog.URL_TOOLS:
        url = candidate.get(key)
        if not url or source in already_covered_sources or calls_made >= tools.catalog.MAX_TOOL_CALLS_PER_PASS:
            continue
        calls_made += 1
        _emit_step(state, f"🔧 Calling {tool_name}(url={url})...")
        output = tools.catalog.dispatch(tool_name, {"url": url}, candidate, client=None)
        urls = output.get("urls") or []
        findings_text = output.get("findings", "") or "No findings."
        status = "SUCCESS" if urls else "NOT_FOUND"
        results.append({
            "heading": label, "query": url, "source": source,
            "findings": findings_text, "status": status, "urls": urls, "iteration": iteration,
        })
        _emit_step(state, f"{'✅' if status == 'SUCCESS' else '⏭️'} {label}: {status}.")

    if calls_made == 0:
        # Make the "why" visible instead of silently falling through to Step
        # 2 -- this is the single most useful diagnostic line when a
        # candidate ends up with zero platform findings: it tells you
        # whether resume URL extraction genuinely found nothing (check the
        # resume for the missing links / PDF hyperlinks) rather than leaving
        # you to guess whether a tool call failed or was skipped.
        known = [f"{label}" for name, key, label, _source in tools.catalog.URL_TOOLS if candidate.get(key)]
        if known and already_covered_sources:
            _emit_step(state, f"⏭️ Researcher: all known profile links ({', '.join(known)}) were already researched in an earlier pass -- not re-fetching.")
        else:
            _emit_step(
                state,
                f"⏭️ Researcher: no known profile links on file for this candidate out of "
                f"{len(tools.catalog.URL_TOOLS)} tracked platforms"
                + " -- check that the resume text/PDF hyperlinks actually contain these URLs.",
            )

    # Step 2 -- LLM-judged: only the genuinely ambiguous decisions are left
    # to the model -- whether checking Medium/Scholar/arXiv is worth it (no
    # direct URL, name-searched), whether a GitHub topic search adds value,
    # and what (if anything) needs a general web search. The tool roster
    # passed here is restricted to exactly these (AMBIGUOUS_OLLAMA_TOOL_
    # DECLARATIONS) so the model can't re-select an already-handled URL tool.
    _emit_step(state, "🔎 Researcher: deciding on additional judgment-based research...")
    plan_hint = json.dumps(work_items, indent=2) if work_items else "(no specific plan items; use judgment based on the job and candidate)"
    all_covered = list(state.get("research_results") or []) + results  # prior passes + this pass's Step 1
    covered_summary = "; ".join(f"{r.get('source')} ({r.get('status')})" for r in all_covered) or "(none yet)"

    context = f"""
You are the Researcher Agent conducting evidence-gathering research pass {iteration} on a job candidate.

JOB: {state['job']['title']}
CANDIDATE: {candidate['name']}
Resume excerpt: {(candidate.get('resume_text') or 'N/A')[:1000]}

RESEARCH GOALS from the Planner (hints on what to investigate, not literal instructions):
{plan_hint}
{f'''
RECRUITER PRIORITY INSTRUCTIONS FOR THIS BATCH -- bias your judgment calls below (which of
Medium/Scholar/arXiv/GitHub-topic/web-search to actually call, and what to search for) toward
gathering evidence relevant to this:
{state['job']['recruiter_instructions']}
''' if state['job'].get('recruiter_instructions') else ''}
ALREADY RESEARCHED (every platform with a known profile link/username has already been
checked deterministically -- do not ask for these again, they are not in your tool list):
{covered_summary}

The only tools available to you now are for genuinely judgment-based decisions:
- get_medium_articles / get_scholar_papers / get_arxiv_papers: call if worth checking (these
  search by name, not a known URL).
- get_github_topic_data: call only if a specific technology/topic from the research goals is
  worth verifying against the candidate's repos, and only if GitHub was found above.
- web_search_tool: this candidate is very unlikely to be a public figure. A generic web search
  CANNOT answer narrative questions like "what was their specific role" or "what technologies
  did they use at company X" -- companies don't publish per-employee details, and an ordinary
  person has no public write-up of their day-to-day work. Do NOT generate multiple narrative
  sub-questions about the same company; that wastes calls on things web search structurally
  cannot answer. If a past company is worth checking at all, use AT MOST ONE combined query
  per company (e.g. "{candidate['name']} {{company name}}") to check for any public trace at
  all (news mention, published article, conference talk, public repo). Getting NOT_FOUND is
  the expected, normal outcome for most candidates -- it is not a sign you asked wrong or
  should retry with a different phrasing. Call this at most twice total this pass, and only
  when a specific, checkable claim exists -- not to fish for narrative detail.
Do not call anything if nothing here is relevant.
"""

    try:
        tool_calls = tools.catalog.select_tools(context, client=client, tool_declarations=tools.catalog.AMBIGUOUS_OLLAMA_TOOL_DECLARATIONS)
    except Exception as e:
        _emit_step(state, f"⚠️ Researcher: judgment-based tool-selection call failed ({e}); skipping this part (platform links above were already researched).")
        tool_calls = []

    web_search_quota_exhausted = False  # set on first QuotaExceededError; skips remaining Gemini web searches this pass

    for call in (tool_calls or []):
        name = call.get("name")
        if not name:
            continue
        if calls_made >= tools.catalog.MAX_TOOL_CALLS_PER_PASS:
            break
        args = dict(call.get("args") or {})
        source = tools.catalog.infer_source_from_tool(name)
        label = tools.catalog.get_tool_label(name)

        if name == "web_search_tool" and grounded_calls >= MAX_GROUNDED_CALLS_PER_PASS:
            # Check the cap BEFORE emitting a "Calling..." line -- otherwise
            # this shows up as a misleading log entry for a search that never
            # actually ran.
            query = args.get("query", "")
            calls_made += 1
            _emit_step(state, f"⏭️ Web search limit reached for this pass ({MAX_GROUNDED_CALLS_PER_PASS} max) -- skipping \"{query}\".")
            results.append({
                "heading": f"Web search: {query}", "query": query, "source": source,
                "findings": "Web search call limit reached for this pass.",
                "status": "NOT_FOUND", "urls": [], "iteration": iteration,
            })
            continue

        calls_made += 1
        arg_str = ", ".join(f"{k}={v}" for k, v in args.items())
        _emit_step(state, f"🔧 Calling {name}({arg_str})...")

        if name == "web_search_tool":
            query = args.get("query", "")
            candidate_name = candidate.get("name")
            # AICredits-only for now: Gemini grounding is disabled (commented
            # out below, not deleted), so this always goes through Tavily.
            grounded_calls += 1
            text, urls = tools.tavily_search(query, candidate_name=candidate_name)
            # if web_search_quota_exhausted or client is None:
            #     text, urls = tools.tavily_search(query, candidate_name=candidate_name)
            # else:
            #     grounded_calls += 1
            #     try:
            #         text, urls = tools.grounded_search(client, query, linkedin=False, candidate_name=candidate_name)
            #     except tools.QuotaExceededError:
            #         web_search_quota_exhausted = True
            #         _emit_step(state, "⚠️ Gemini web search quota exhausted, switching to Tavily fallback...")
            #         text, urls = tools.tavily_search(query, candidate_name=candidate_name)
            _NOT_FOUND_PHRASES = ("search failed", "quota exhausted", "unavailable", "did not clearly reference", "no results specific to", "no credible results found")
            status = "SUCCESS" if urls or (text and not any(p in text.lower() for p in _NOT_FOUND_PHRASES)) else "NOT_FOUND"
            results.append({
                "heading": f"Web search: {query}", "query": query, "source": source,
                "findings": text or "No findings.", "status": status, "urls": urls, "iteration": iteration,
            })
            continue

        output = tools.catalog.dispatch(name, args, candidate, client=client)
        urls = output.get("urls") or []
        findings_text = output.get("findings", "") or "No findings."
        status = "SUCCESS" if urls else "NOT_FOUND"
        results.append({
            "heading": label, "query": args.get("url") or args.get("topic") or args.get("query") or "",
            "source": source, "findings": findings_text, "status": status,
            "urls": urls, "iteration": iteration,
        })
        _emit_step(state, f"{'✅' if status == 'SUCCESS' else '⏭️'} {label}: {status}.")

    if calls_made == 0:
        _emit_step(state, "⏭️ Researcher: no tools were called this pass (no known profile links, and no judgment-based research was warranted).")

    logs.append(
        f"Researcher pass {iteration}: executed {len(results)} tool call(s) "
        f"({'follow-up requests' if additional else 'initial plan'})."
    )
    _emit_step(state, f"✅ Researcher: pass {iteration} complete, {len(results)} finding(s) gathered.")

    return {
        "research_results": results,           # appended via reducer
        "research_iterations": iteration,      # last-write-wins
        "additional_requests": [],             # clear the handoff
        "github_bundle": github_bundle,        # cache for later passes
        "logs": logs,
    }


def evaluator_node(state: AgentState) -> Dict[str, Any]:
    """Pure judge. Scores dimensions from cited evidence; may request more research."""
    print("[Evaluator] Running Agent 3: Technical Evaluator...")
    evidence_count = len(state.get("research_results") or [])
    _emit_step(state, f"🧮 Evaluator: scoring candidate against {evidence_count} research finding(s)...")
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
    core_skills = (state.get("planner_output") or {}).get("core_skills_to_verify", [])
    iteration = state.get("research_iterations", 0)

    prompt = f"""
You are the Technical Evaluator Agent — an impartial judge. Assess the candidate STRICTLY against the cited research evidence below. Do not invent facts.

Rules:
- Only list a skill under verified_skills if a research finding (with a source URL) supports it. Resume-only claims are NOT verified.
- Score each dimension 0-100 based on the evidence.
{f'''- RECRUITER PRIORITY INSTRUCTIONS are provided below (see JOB DETAILS). Weight them heavily in the
  dimension scores and the overall_fit_percentage -- treat them as the primary lens for judging fit among
  candidates who otherwise look comparable, not merely a tiebreaker. Still score STRICTLY from cited evidence;
  never invent or inflate evidence to satisfy the instructions.''' if state['job'].get('recruiter_instructions') else ''}
- You MUST populate the evidence list. Whenever any research finding has a status of SUCCESS, include at least 3 evidence items, each pairing a concrete claim with a supporting source_url taken from that finding's `urls` (use source_type RESUME with source_url "resume" only for claims backed solely by the resume). Never return an empty evidence list when SUCCESS findings exist.
- If the evidence is too thin to judge confidently AND this is not already the final allowed pass ({iteration} of {MAX_RESEARCH_ITERATIONS}), set evidence_sufficient=false and provide as many targeted additional_research_requests as are genuinely needed to close the gaps -- do not artificially limit the count. Otherwise set evidence_sufficient=true and leave additional_research_requests empty.

JOB DETAILS:
Title: {state['job']['title']}
Description: {state['job']['description']}
Requirements: {state['job']['requirements'] or "N/A"}
Core skills to verify: {", ".join(core_skills) or "N/A"}
{f"Recruiter priority instructions: {state['job']['recruiter_instructions']}" if state['job'].get('recruiter_instructions') else ""}

CANDIDATE:
Name: {state['candidate']['name']}
Resume Text: {state['candidate']['resume_text'] or "N/A"}

RESEARCH EVIDENCE (with source URLs):
{research_json}
"""

    try:
        eval_data = llm_client.structured_generate(prompt, EvaluatorOutputSchema, temperature=0.2)

        # Guarantee non-empty, genuinely-sourced evidence: if the model left the
        # evidence list empty but real research succeeded, synthesize items from
        # the actual findings' headings + URLs (factual, not fabricated).
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
                        "claim": r.get("heading") or "Research finding",
                        "source_url": url,
                        "source_type": r.get("source") or "WEB_SEARCH",
                    })
                    if len(synth) >= 8:
                        break
                if len(synth) >= 8:
                    break
            eval_data["evidence"] = synth

        sufficient = bool(eval_data.get("evidence_sufficient", True))
        requests_list = eval_data.get("additional_research_requests") or []
        # Only propagate follow-up requests when we're actually going to loop.
        can_loop = (not sufficient) and requests_list and iteration < MAX_RESEARCH_ITERATIONS
        print(f"[Evaluator] Done. evidence_sufficient={sufficient}, will_loop={bool(can_loop)}")
        _emit_step(state, (
            f"🔁 Evaluator: evidence too thin, requesting {len(requests_list)} more research item(s)..."
            if can_loop else
            f"✅ Evaluator: done (fit {eval_data.get('overall_fit_percentage')}%)."
        ))
        return {
            "evaluation": eval_data,
            "additional_requests": requests_list if can_loop else [],
            "logs": [
                f"Evaluator scored the candidate (fit {eval_data.get('overall_fit_percentage')}%). "
                + (f"Requested {len(requests_list)} more research items." if can_loop else "Evidence sufficient.")
            ],
        }
    except Exception as e:
        print(f"[Evaluator Error] {e}")
        return {
            "evaluation": {
                "dimension_scores": {"skills": 0, "experience": 0, "project_complexity": 0, "education": 0, "public_work": 0},
                "overall_fit_percentage": 0,
                "verified_skills": [],
                "gaps_or_concerns": ["Evaluation failed due to an internal error."],
                "evidence": [],
                "evidence_sufficient": True,
                "additional_research_requests": [],
            },
            "additional_requests": [],
            "logs": [f"Evaluator Agent failed: {str(e)}"],
        }


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

        prompt = f"""
You are the Report Writer Agent. Using the evaluation and the research evidence, write a concise, professional hiring report for a recruiter.
Be specific and reference concrete evidence. Surface any red flags (inconsistencies between resume and public evidence, thin public work, etc.). Write interview questions that probe the identified gaps and verify the claimed strengths.

JOB: {state['job']['title']}
CANDIDATE: {state['candidate']['name']}

EVALUATION:
{eval_json}

RESEARCH EVIDENCE:
{research_json}
"""

        try:
            rw = llm_client.structured_generate(prompt, ReportWriterOutputSchema, temperature=0.4)
            report_logs = ["Report Writer compiled the final hiring report."]
        except Exception as e:
            print(f"[ReportWriter Error] {e}")
            rw = {
                "summary": "Report generation failed; showing evaluation data only.",
                "narrative": "",
                "red_flags": [],
                "interview_questions": [],
                "hiring_recommendation": "Manual review required.",
                "verdict": "POTENTIAL_MATCH",
            }
            report_logs = [f"Report Writer failed: {str(e)}"]

    # Merge into the superset final_report (legacy keys preserved for the UI +
    # Application sync; new keys are additive).
    final_report = {
        # legacy keys (UI + Application sync depend on these):
        "overall_fit_percentage": ev.get("overall_fit_percentage", 0),
        "summary": rw.get("summary", ""),
        "verified_skills": ev.get("verified_skills", []),
        "gaps_or_concerns": ev.get("gaps_or_concerns", []),
        "interview_questions": rw.get("interview_questions", []),
        "verdict": rw.get("verdict", "POTENTIAL_MATCH"),
        # extensions:
        "dimension_scores": ev.get("dimension_scores", {}),
        "evidence": ev.get("evidence", []),
        "red_flags": rw.get("red_flags", []),
        "narrative": rw.get("narrative", ""),
        "hiring_recommendation": rw.get("hiring_recommendation", ""),
        "research_iterations": state.get("research_iterations", 0),
    }

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
