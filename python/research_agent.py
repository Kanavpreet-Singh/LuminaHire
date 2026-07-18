from __future__ import annotations

"""
LuminaHire — Tool-Calling Research Agent (HITL follow-up)
===========================================================
Handles the human-in-the-loop "ask the researcher to dig deeper" flow: a
recruiter types free text (e.g. "check if they've written technical articles"
or "look for a MERN stack repo"), and an LLM genuinely DECIDES which tool(s) to
call and with what arguments — this is real function-calling, not deterministic
keyword dispatch.

Separation of concerns:
  - tools/catalog.py:  the shared, guardrailed tool roster + dispatch + source
                        inference, used by BOTH this follow-up flow and the
                        main researcher_node pass in agents.py.
  - research_agent.py: this module just builds the follow-up-specific prompt
                        (including what's already been researched this
                        session, so the model doesn't redundantly re-call a
                        tool already covered) and turns the results into
                        research_results[]-shaped findings.

No separate synthesis LLM call is needed: every tool in the catalog already
returns clean, evaluator-ready findings text (see tools/catalog.py), so this
mirrors agents.py's main-pass researcher_node -- one LLM call total per
follow-up (tool selection), not two.
"""

import os
from typing import Any, Dict, List, Optional

import tools

USE_MOCK_AI = os.getenv("MOCK_AI_RESPONSES", "1") != "0"


# ── Mock mode ──────────────────────────────────────────────────

_MOCK_KEYWORD_TOOLS = [
    (("repo", "code", "stack", "project"), "get_github_topic_data", "github_url", "GITHUB"),
    (("linkedin",), "get_linkedin_data", "linkedin_url", "LINKEDIN"),
    (("leetcode",), "get_leetcode_data", "leetcode_url", "LEETCODE"),
    (("gfg", "geeksforgeeks"), "get_gfg_data", "gfg_url", "GFG"),
    (("codeforces",), "get_codeforces_data", "codeforces_url", "CODEFORCES"),
    (("hackerrank",), "get_hackerrank_data", "hackerrank_url", "HACKERRANK"),
    (("codechef",), "get_codechef_data", "codechef_url", "CODECHEF"),
    (("medium", "article", "blog", "write", "publication"), "get_medium_articles", "medium_url", "MEDIUM"),
    (("dev.to", "devto"), "get_devto_articles", "devto_url", "DEVTO"),
    (("stack overflow", "stackoverflow"), "get_stackoverflow_data", "stackoverflow_url", "STACKOVERFLOW"),
    (("npm", "package"), "get_npm_packages", "npm_username", "NPM"),
    (("scholar", "paper", "publication", "research"), "get_scholar_papers", None, "SCHOLAR"),
    (("arxiv",), "get_arxiv_papers", None, "ARXIV"),
    (("portfolio", "personal site", "personal website"), "get_portfolio_website_data", "portfolio_url", "PORTFOLIO"),
]


def _mock_guided_research(candidate: Dict[str, Any], instruction: str, iteration: int, already_covered: List[str]) -> Dict[str, Any]:
    lowered = instruction.lower()

    matched = next(
        ((tool_name, url_key, source) for keywords, tool_name, url_key, source in _MOCK_KEYWORD_TOOLS
         if any(k in lowered for k in keywords)),
        None,
    )

    if matched is None:
        # Default: generic web search.
        tool_name, args = "web_search_tool", {"query": instruction.strip()}
        heading = f"Follow-up web search: {instruction.strip()[:60]}"
        findings = f"Mock search for \"{instruction.strip()}\" returned general public information consistent with the resume."
        source = "WEB_SEARCH"
        urls = [{"url": f"https://example.com/mock/{candidate['name'].lower().replace(' ', '-')}", "title": ""}]
    else:
        tool_name, url_key, source = matched
        url = candidate.get(url_key) if url_key else "(searchable by name)"
        heading = f"Follow-up {source.title()} check"
        if url_key and not candidate.get(url_key):
            args = {"url": ""}
            findings = f"No {source.title()} profile URL found for this candidate."
            status_found = False
            urls = []
        else:
            args = {"url": url} if url_key else {}
            findings = f"Mock {source.title()} check for \"{instruction.strip()}\" shows activity consistent with the request."
            status_found = True
            urls = [{"url": url if url_key else f"https://example.com/mock/{source.lower()}", "title": ""}]

        if source in already_covered and status_found:
            findings = f"(Already covered earlier this session; re-checked per recruiter request) {findings}"

    new_result = {
        "heading": heading,
        "query": instruction.strip(),
        "source": source,
        "findings": findings,
        "status": "SUCCESS" if (matched is None or urls) else "NOT_FOUND",
        "urls": urls,
        "iteration": iteration,
        "triggered_by": "human_followup",
    }
    return {
        "new_results": [new_result],
        "tool_calls": [{"tool": tool_name, "args": args}],
        "logs": [f"Guided research (mock): ran {tool_name} for instruction \"{instruction.strip()[:80]}\"."],
    }


# ── Real mode ──────────────────────────────────────────────────

def _summarize_covered_sources(research_results: Optional[List[Dict[str, Any]]]) -> str:
    """
    Build the "already researched this session" context line so the follow-up
    LLM call can genuinely rethink given what's already known, instead of
    redundantly re-calling a tool already covered (round-1-awareness).
    """
    if not research_results:
        return "(nothing researched yet this session)"
    by_source: Dict[str, int] = {}
    for r in research_results:
        src = (r.get("source") or "WEB_SEARCH").upper()
        status = r.get("status", "")
        key = f"{src} ({status})" if status else src
        by_source[key] = by_source.get(key, 0) + 1
    return ", ".join(f"{label} x{count}" if count > 1 else label for label, count in by_source.items())


def _select_and_run_tools(client: Any, instruction: str, candidate: Dict[str, Any],
                          research_results: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """Ask Gemini which tool(s) to call for this free-text instruction, execute them
    deterministically via tools.catalog, and return raw {tool, args, output} records."""
    available_links = tools.catalog.build_available_links_context(candidate)
    already_covered = _summarize_covered_sources(research_results)

    context = (
        f"Candidate: {candidate.get('name')}\n\n"
        f"CANDIDATE PROFILE LINKS (only call a tool for a platform with a real link/username below):\n{available_links}\n\n"
        f"ALREADY RESEARCHED THIS SESSION: {already_covered}\n"
        "Do not repeat a tool call for a source already listed above unless the recruiter's instruction "
        "below specifically asks you to re-check or go deeper on that same platform. Focus on what's genuinely new.\n\n"
        f"RECRUITER INSTRUCTION: {instruction}\n\n"
        "Decide which tool(s) to call to satisfy this instruction, following the rules above. "
        "You may call more than one tool if needed."
    )

    try:
        tool_calls = tools.catalog.select_tools(context, client=client)
    except Exception:
        # Degrade gracefully (e.g. Gemini quota exhausted, or Ollama
        # unreachable under LLM_PROVIDER=ollama) -- run_guided_research
        # already has a "no tool records" branch that returns a clean
        # NOT_FOUND-shaped response instead of a hard 500.
        return []

    records: List[Dict[str, Any]] = []
    calls = 0
    for call in tool_calls:
        name = call.get("name")
        if not name:
            continue
        if calls >= tools.catalog.MAX_TOOL_CALLS_PER_PASS:
            break
        calls += 1
        args = dict(call.get("args") or {})
        # dispatch() already handles web_search_tool (degrades cleanly to
        # "unavailable" when client is None, e.g. under LLM_PROVIDER=ollama
        # with no Gemini key configured) -- no need to special-case it here.
        output = tools.catalog.dispatch(name, args, candidate, client=client)

        records.append({"tool": name, "args": args, "output": output})

    return records


def run_guided_research(job: Dict[str, Any], candidate: Dict[str, Any],
                         planner_output: Optional[Dict[str, Any]],
                         research_results: Optional[List[Dict[str, Any]]],
                         instruction: str) -> Dict[str, Any]:
    """
    Entry point used by main.py's /vet/research/followup endpoint. Runs the LLM
    tool-selection pass (aware of what's already been researched this session,
    so it targets genuinely new ground), executes the chosen tools, and
    returns {new_results, tool_calls, logs}. new_results is additive (caller
    appends it to the session's existing research_results, never replaces --
    round 1's data is never touched).
    """
    iteration = max((r.get("iteration", 0) for r in (research_results or [])), default=1)
    already_covered = sorted({(r.get("source") or "WEB_SEARCH").upper() for r in (research_results or [])})

    if USE_MOCK_AI:
        return _mock_guided_research(candidate, instruction, iteration, already_covered)

    # AICredits-only for now, per explicit request: no Gemini client is
    # constructed (commented out below, not deleted -- uncomment to restore).
    client = None
    # from agents import get_genai_client
    # try:
    #     client = get_genai_client()
    # except Exception:
    #     client = None

    tool_records = _select_and_run_tools(client, instruction, candidate, research_results)
    if not tool_records:
        return {
            "new_results": [{
                "heading": "Follow-up research",
                "query": instruction,
                "source": "WEB_SEARCH",
                "findings": "The research agent did not select any tool for this instruction. Try rephrasing it.",
                "status": "NOT_FOUND",
                "urls": [],
                "iteration": iteration,
                "triggered_by": "human_followup",
            }],
            "tool_calls": [],
            "logs": ["Guided research: no tool call was selected for the given instruction."],
        }

    new_results: List[Dict[str, Any]] = []
    for record in tool_records:
        name = record["tool"]
        output = record.get("output") or {}
        urls = output.get("urls") or []
        findings_text = output.get("findings", "") or "No findings."
        source = tools.catalog.infer_source_from_tool(name)
        label = tools.catalog.get_tool_label(name)
        new_results.append({
            "heading": f"Follow-up: {label}",
            "query": str(record.get("args") or {}),
            "source": source,
            "findings": findings_text,
            "status": "SUCCESS" if urls else "NOT_FOUND",
            "urls": urls,
            "iteration": iteration,
            "triggered_by": "human_followup",
        })

    return {
        "new_results": new_results,
        "tool_calls": [{"tool": r["tool"], "args": r["args"]} for r in tool_records],
        "logs": [f"Guided research: ran {len(tool_records)} tool call(s) for instruction \"{instruction[:80]}\"."],
    }
