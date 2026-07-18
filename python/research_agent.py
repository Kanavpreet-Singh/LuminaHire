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
  - tools.py:          deterministic tool EXECUTION (no LLM judgment).
  - research_agent.py: tool SELECTION (the actual agentic decision) + synthesis
                        of raw tool output into the pipeline's finding shape.

SDK constraint (same one documented in tools.py): a Gemini call with custom
function_declarations cannot also request response_schema/JSON structured
output. So this module makes two separate Gemini calls: (1) tool selection via
function-calling, (2) synthesis of the raw tool output into structured findings
via llm_client.structured_generate.
"""

import os
import json
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field
from google.genai import types

import tools
import llm_client

MODEL = "gemini-2.5-flash"
MAX_TOOL_CALLS_PER_FOLLOWUP = 4
USE_MOCK_AI = os.getenv("MOCK_AI_RESPONSES", "1") != "0"


# ── Tool declarations (JSON-schema parameters for Gemini function-calling) ──

_WEB_SEARCH_DECL = types.FunctionDeclaration(
    name="web_search_tool",
    description="Search the public web (including articles, blog posts, professional profiles) for information about the candidate.",
    parameters_json_schema={
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "The search query, e.g. 'Jane Doe technical blog articles'"},
        },
        "required": ["query"],
    },
)

_GITHUB_PROFILE_DECL = types.FunctionDeclaration(
    name="github_profile_tool",
    description="Fetch the candidate's public GitHub profile: bio, repos, languages, and recent activity.",
    parameters_json_schema={
        "type": "object",
        "properties": {
            "username": {"type": "string", "description": "The candidate's GitHub username"},
        },
        "required": ["username"],
    },
)

_GITHUB_TOPIC_DECL = types.FunctionDeclaration(
    name="github_topic_search_tool",
    description="Search the candidate's GitHub repositories for a specific topic or technology, e.g. 'MERN stack', 'machine learning', 'compiler'.",
    parameters_json_schema={
        "type": "object",
        "properties": {
            "username": {"type": "string", "description": "The candidate's GitHub username"},
            "topic": {"type": "string", "description": "The topic/technology/keyword to search for"},
        },
        "required": ["username", "topic"],
    },
)

_TOOL = types.Tool(function_declarations=[_WEB_SEARCH_DECL, _GITHUB_PROFILE_DECL, _GITHUB_TOPIC_DECL])


# ── Structured Output Schema (for synthesis pass) ────────────────

class FollowupFindingSchema(BaseModel):
    heading: str = Field(description="A short, catchy title for this finding")
    findings: str = Field(description="Concise summary of what was learned, grounded in the raw tool output")
    status: str = Field(description="SUCCESS, NOT_FOUND, or ERROR")


class FollowupResultSchema(BaseModel):
    items: List[FollowupFindingSchema] = Field(description="One item per tool call made")


# ── Mock mode ──────────────────────────────────────────────────

def _mock_guided_research(candidate: Dict[str, Any], instruction: str, iteration: int) -> Dict[str, Any]:
    lowered = instruction.lower()
    username = tools.extract_github_username(candidate.get("github_url")) or candidate["name"].lower().replace(" ", "-")

    if any(k in lowered for k in ("repo", "code", "stack", "project", "github")):
        tool_name, args = "github_topic_search_tool", {"username": username, "topic": instruction.strip()[:60]}
        heading = f"Follow-up GitHub topic search: {instruction.strip()[:60]}"
        findings = f"Mock search found repositories from @{username} plausibly related to \"{instruction.strip()}\"."
        source = "GITHUB"
        urls = [{"url": f"https://github.com/{username}", "title": username}]
    elif any(k in lowered for k in ("article", "blog", "write", "publication")):
        tool_name, args = "web_search_tool", {"query": f"{candidate['name']} technical articles blog"}
        heading = "Follow-up web search: published writing"
        findings = f"Mock search found no strong evidence of published articles by {candidate['name']}, but some forum activity was noted."
        source = "WEB_SEARCH"
        urls = [{"url": f"https://example.com/mock/{username}-writing", "title": ""}]
    else:
        tool_name, args = "web_search_tool", {"query": instruction.strip()}
        heading = f"Follow-up web search: {instruction.strip()[:60]}"
        findings = f"Mock search for \"{instruction.strip()}\" returned general public information consistent with the resume."
        source = "WEB_SEARCH"
        urls = [{"url": f"https://example.com/mock/{username}", "title": ""}]

    new_result = {
        "heading": heading,
        "query": instruction.strip(),
        "source": source,
        "findings": findings,
        "status": "SUCCESS",
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

def _select_and_run_tools(client: Any, instruction: str, candidate: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Ask Gemini which tool(s) to call for this free-text instruction, execute them
    deterministically via tools.py, and return raw {tool, args, output} records."""
    username = tools.extract_github_username(candidate.get("github_url"))
    context = (
        f"Candidate: {candidate.get('name')}\n"
        f"GitHub username: {username or 'unknown'}\n"
        f"Recruiter instruction: {instruction}\n\n"
        "Decide which tool(s) to call to satisfy this instruction. Call web_search_tool for "
        "public web/articles/professional-profile research, github_profile_tool for a general "
        "GitHub profile check, or github_topic_search_tool when a specific technology/topic/stack "
        "is mentioned. You may call more than one tool if needed."
    )

    resp = client.models.generate_content(
        model=MODEL,
        contents=context,
        config=types.GenerateContentConfig(tools=[_TOOL], temperature=0.1),
    )

    records: List[Dict[str, Any]] = []
    candidates = getattr(resp, "candidates", None) or []
    if not candidates:
        return records

    parts = getattr(candidates[0].content, "parts", None) or []
    calls = 0
    for part in parts:
        fc = getattr(part, "function_call", None)
        if not fc or not getattr(fc, "name", None):
            continue
        if calls >= MAX_TOOL_CALLS_PER_FOLLOWUP:
            break
        calls += 1
        name = fc.name
        args = dict(fc.args or {})

        try:
            if name == "web_search_tool":
                output = tools.web_search_tool(client, args.get("query", instruction))
            elif name == "github_profile_tool":
                output = tools.github_profile_tool(args.get("username") or username or "")
            elif name == "github_topic_search_tool":
                output = tools.github_topic_search_tool(args.get("username") or username or "", args.get("topic", instruction))
            else:
                output = {"findings": f"Unknown tool requested: {name}", "urls": []}
        except Exception as e:
            output = {"findings": f"Tool '{name}' failed: {e}", "urls": []}

        records.append({"tool": name, "args": args, "output": output})

    return records


def run_guided_research(job: Dict[str, Any], candidate: Dict[str, Any],
                         planner_output: Optional[Dict[str, Any]],
                         research_results: Optional[List[Dict[str, Any]]],
                         instruction: str) -> Dict[str, Any]:
    """
    Entry point used by main.py's /vet/research/followup endpoint. Runs the LLM
    tool-selection pass, executes the chosen tools, synthesizes the raw output
    into findings shaped like researcher_node's output, and returns
    {new_results, tool_calls, logs}. new_results is additive (caller appends it
    to the session's existing research_results, never replaces).
    """
    iteration = max((r.get("iteration", 0) for r in (research_results or [])), default=1)

    if USE_MOCK_AI:
        return _mock_guided_research(candidate, instruction, iteration)

    from agents import get_genai_client
    client = get_genai_client()

    tool_records = _select_and_run_tools(client, instruction, candidate)
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

    synthesis_prompt = f"""
You are summarizing the results of targeted follow-up research on a job candidate, requested by a
recruiter. For EACH tool call below, produce one finding item with a short heading, a concise
factual summary of what the raw output shows (do not invent facts beyond it), and a status
(SUCCESS if the raw output has real information, NOT_FOUND if it found nothing, ERROR if it failed).

RECRUITER INSTRUCTION: {instruction}

CANDIDATE: {candidate.get('name')}
JOB: {job.get('title')}

TOOL CALLS AND RAW OUTPUT:
{json.dumps(tool_records, indent=2)}
"""

    try:
        synthesized = llm_client.structured_generate(synthesis_prompt, FollowupResultSchema, temperature=0.2)
        items = synthesized.get("items") or []
    except Exception:
        # Synthesis failed; fall back to the raw tool output verbatim so the
        # follow-up isn't silently lost.
        items = [{"heading": r["tool"], "findings": json.dumps(r["output"])[:500], "status": "SUCCESS"} for r in tool_records]

    new_results: List[Dict[str, Any]] = []
    for idx, item in enumerate(items):
        raw = tool_records[idx] if idx < len(tool_records) else tool_records[-1]
        source = (
            "GITHUB" if raw["tool"] in ("github_profile_tool", "github_topic_search_tool")
            else "WEB_SEARCH"
        )
        new_results.append({
            "heading": item.get("heading") or raw["tool"],
            "query": json.dumps(raw.get("args") or {}),
            "source": source,
            "findings": item.get("findings", ""),
            "status": item.get("status", "SUCCESS"),
            "urls": (raw.get("output") or {}).get("urls") or [],
            "iteration": iteration,
            "triggered_by": "human_followup",
        })

    return {
        "new_results": new_results,
        "tool_calls": [{"tool": r["tool"], "args": r["args"]} for r in tool_records],
        "logs": [f"Guided research: ran {len(tool_records)} tool call(s) for instruction \"{instruction[:80]}\"."],
    }
