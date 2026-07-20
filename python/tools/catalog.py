"""
LuminaHire — Shared Tool Catalog (the ReAct guardrail)
=========================================================
The closed, curated set of tools the Researcher (both the main pass in
agents.py's researcher_node, and the HITL follow-up in research_agent.py) is
allowed to call. This is what "guardrails" the LLM against wandering into
unnecessary open-web search: every entry here is a specific, purpose-built
data source, and there is exactly ONE deliberately generic fallback
(web_search_tool), described as a last resort.

TOOL_DECLARATIONS: the Gemini FunctionDeclaration list for the tool-calling
                    turn.
dispatch():         one dict-keyed lookup from a tool name to its execution,
                    replacing the if/elif chains that used to be duplicated
                    between agents.py and research_agent.py.
infer_source_from_tool(): maps a tool name to the research_results[].source
                    label used throughout the rest of the pipeline.

Building the "Available profile links" context section (with the actual
resolved URLs, not just yes/no) is the caller's job -- see
build_available_links_context() below, shared so both callers format it
identically.
"""

import json
from typing import Any, Dict, List

import requests
from google.genai import types

import llm_client
import tracing
from . import (
    github_tool, linkedin_tool, leetcode_tool, gfg_tool, codeforces_tool,
    hackerrank_tool, codechef_tool, medium_tool, devto_tool, stackoverflow_tool,
    scholar_tool, arxiv_tool, npm_tool, portfolio_tool, web_search,
)

MAX_TOOL_CALLS_PER_PASS = 10

# (tool name, candidate URL key, human label) -- the platforms addressed by a
# single "give me the URL" tool. Drives both the FunctionDeclaration list and
# the "Available profile links" context builder below, so the two can never
# drift out of sync.
_URL_TOOLS = [
    ("get_github_data", "github_url", "GitHub", "GITHUB"),
    ("get_linkedin_data", "linkedin_url", "LinkedIn", "LINKEDIN"),
    ("get_leetcode_data", "leetcode_url", "LeetCode", "LEETCODE"),
    ("get_gfg_data", "gfg_url", "GeeksforGeeks", "GFG"),
    ("get_codeforces_data", "codeforces_url", "Codeforces", "CODEFORCES"),
    ("get_hackerrank_data", "hackerrank_url", "HackerRank", "HACKERRANK"),
    ("get_codechef_data", "codechef_url", "CodeChef", "CODECHEF"),
    ("get_devto_articles", "devto_url", "Dev.to", "DEVTO"),
    ("get_stackoverflow_data", "stackoverflow_url", "Stack Overflow", "STACKOVERFLOW"),
    ("get_npm_packages", "npm_username", "npm", "NPM"),
    ("get_portfolio_website_data", "portfolio_url", "personal portfolio site", "PORTFOLIO"),
]

# Tools that operate on the whole candidate (name-matched search), not a
# single known URL -- still guardrailed (only called when relevant), but
# their FunctionDeclaration takes no required args since dispatch() already
# has the candidate dict.
_CANDIDATE_TOOLS = [
    ("get_medium_articles", "medium_url", "Medium", "MEDIUM"),
    ("get_scholar_papers", "scholar_url", "Google Scholar / academic papers", "SCHOLAR"),
    ("get_arxiv_papers", None, "arXiv", "ARXIV"),
]

_GITHUB_TOPIC_TOOL = "get_github_topic_data"
_WEB_SEARCH_TOOL = "web_search_tool"


def _url_spec(name: str, label: str) -> Dict[str, Any]:
    return {
        "name": name,
        "description": f"Fetch the candidate's public {label} profile data. Only call this if a {label} URL is known.",
        "parameters": {
            "type": "object",
            "properties": {"url": {"type": "string", "description": f"The candidate's exact {label} profile URL"}},
            "required": ["url"],
        },
    }


def _no_arg_spec(name: str, label: str) -> Dict[str, Any]:
    return {
        "name": name,
        "description": f"Search for the candidate's {label}, matched by name. Call only when relevant to the research goals.",
        "parameters": {"type": "object", "properties": {}},
    }


# Single source of truth for every tool's callable signature -- both the
# Gemini FunctionDeclaration list and the Ollama/OpenAI-style tool list below
# are derived from this so the two provider formats can never drift apart.
_TOOL_SPECS: List[Dict[str, Any]] = [
    *[_url_spec(name, label) for name, _key, label, _source in _URL_TOOLS],
    {
        "name": _GITHUB_TOPIC_TOOL,
        "description": "Search the candidate's GitHub repositories for a specific topic or technology (e.g. 'MERN stack', 'machine learning'). Only call if a GitHub URL is known.",
        "parameters": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "The candidate's GitHub profile URL"},
                "topic": {"type": "string", "description": "The topic/technology/keyword to search for"},
            },
            "required": ["url", "topic"],
        },
    },
    *[_no_arg_spec(name, label) for name, _key, label, _source in _CANDIDATE_TOOLS],
    {
        "name": _WEB_SEARCH_TOOL,
        "description": (
            "Search the general public web. Use ONLY for claims no other tool covers, and prefer a specific "
            "tool whenever the candidate has a matching profile link. Most candidates are NOT public figures: "
            "a generic search cannot answer narrative questions like 'what was their specific role' or 'what "
            "technologies did they use at company X' -- companies don't publish per-employee details. Do not "
            "ask multiple narrative sub-questions about the same company; use at most ONE combined query per "
            "company/claim (e.g. 'candidate name' + company), and treat NOT_FOUND as the normal, expected "
            "outcome for most people, not a reason to retry with different phrasing. At most 2 calls per pass."
        ),
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "The search query"}},
            "required": ["query"],
        },
    },
]

TOOL_DECLARATIONS = types.Tool(function_declarations=[
    types.FunctionDeclaration(name=spec["name"], description=spec["description"], parameters_json_schema=spec["parameters"])
    for spec in _TOOL_SPECS
])

# Ollama's /api/chat `tools` param (and OpenAI-compatible APIs generally)
# expect this envelope shape rather than Gemini's FunctionDeclaration objects.
OLLAMA_TOOL_DECLARATIONS = [
    {"type": "function", "function": {"name": spec["name"], "description": spec["description"], "parameters": spec["parameters"]}}
    for spec in _TOOL_SPECS
]

# Restricted roster covering only the tool calls that genuinely need LLM
# judgment: the name-searched CANDIDATE_TOOLS (is checking Medium/Scholar/
# arXiv worth it?), GitHub topic search (what topic matters?), and
# web_search_tool (what's worth verifying?). Every _URL_TOOLS platform is
# deliberately excluded -- whether the candidate has a real GitHub/LeetCode/
# etc. URL is unambiguous ground truth, not a judgment call, so the main
# researcher pass calls those deterministically (see agents.py) instead of
# leaving it up to the model. Smaller/cheaper tool-selection models otherwise
# tend to reach for the generic web_search_tool instead of a specific
# platform tool even when a real link is available and explicitly listed.
_AMBIGUOUS_TOOL_NAMES = {name for name, _key, _label, _source in _CANDIDATE_TOOLS} | {_GITHUB_TOPIC_TOOL, _WEB_SEARCH_TOOL}
_AMBIGUOUS_TOOL_SPECS = [spec for spec in _TOOL_SPECS if spec["name"] in _AMBIGUOUS_TOOL_NAMES]

AMBIGUOUS_TOOL_DECLARATIONS = types.Tool(function_declarations=[
    types.FunctionDeclaration(name=spec["name"], description=spec["description"], parameters_json_schema=spec["parameters"])
    for spec in _AMBIGUOUS_TOOL_SPECS
])
AMBIGUOUS_OLLAMA_TOOL_DECLARATIONS = [
    {"type": "function", "function": {"name": spec["name"], "description": spec["description"], "parameters": spec["parameters"]}}
    for spec in _AMBIGUOUS_TOOL_SPECS
]


_SOURCE_BY_TOOL = {name: source for name, _key, _label, source in _URL_TOOLS}
_SOURCE_BY_TOOL.update({name: source for name, _key, _label, source in _CANDIDATE_TOOLS})
_SOURCE_BY_TOOL[_GITHUB_TOPIC_TOOL] = "GITHUB"
_SOURCE_BY_TOOL[_WEB_SEARCH_TOOL] = "WEB_SEARCH"

_LABEL_BY_TOOL = {name: label for name, _key, label, _source in _URL_TOOLS}
_LABEL_BY_TOOL.update({name: label for name, _key, label, _source in _CANDIDATE_TOOLS})
_LABEL_BY_TOOL[_GITHUB_TOPIC_TOOL] = "GitHub"
_LABEL_BY_TOOL[_WEB_SEARCH_TOOL] = "Web Search"


def get_tool_label(name: str) -> str:
    """Human-readable label for a tool name, e.g. 'get_stackoverflow_data' -> 'Stack Overflow'."""
    return _LABEL_BY_TOOL.get(name, name)

_URL_DISPATCH = {
    "get_github_data": github_tool.get_github_data,
    "get_linkedin_data": linkedin_tool.get_linkedin_data,
    "get_leetcode_data": leetcode_tool.get_leetcode_data,
    "get_gfg_data": gfg_tool.get_gfg_data,
    "get_codeforces_data": codeforces_tool.get_codeforces_data,
    "get_hackerrank_data": hackerrank_tool.get_hackerrank_data,
    "get_codechef_data": codechef_tool.get_codechef_data,
    "get_devto_articles": devto_tool.get_devto_articles,
    "get_stackoverflow_data": stackoverflow_tool.get_stackoverflow_data,
    "get_npm_packages": npm_tool.get_npm_packages,
    "get_portfolio_website_data": portfolio_tool.get_portfolio_website_data,
}

# name -> candidate dict key, so dispatch() can enforce the real URL instead
# of trusting whatever string the model put in its function-call "url" arg.
_CANDIDATE_KEY_BY_TOOL = {name: key for name, key, _label, _source in _URL_TOOLS}


def infer_source_from_tool(name: str) -> str:
    """Map a tool name to its research_results[].source label."""
    return _SOURCE_BY_TOOL.get(name, "WEB_SEARCH")


# Public aliases so other modules (e.g. agents.py's mock-mode simulation,
# which needs to know "which platforms have a candidate URL key" without
# duplicating this roster) can reuse the same source-of-truth tables.
URL_TOOLS = _URL_TOOLS
CANDIDATE_TOOLS = _CANDIDATE_TOOLS


@tracing.observe(name="tool_call")
def dispatch(name: str, args: Dict[str, Any], candidate: Dict[str, Any], client: Any = None) -> Dict[str, Any]:
    """
    Execute a tool call by name. Every tool here returns {findings, urls} and
    never raises internally -- but dispatch itself wraps the call in a
    try/except as a last-resort safety net (e.g. a malformed arg dict from
    the model) so one bad tool call can't crash the whole research pass.
    """
    try:
        if name in _URL_DISPATCH:
            # Never trust a "url" argument the model supplied -- always use
            # the candidate's real, resume-extracted URL for this platform.
            # A model can be told "only call this if a link is known" in the
            # prompt, but that's advisory; a disobedient/hallucinating call
            # must not be able to make us fetch a made-up URL (e.g. a plain
            # "leetcode.com/u/users" placeholder instead of the real handle).
            known_url = candidate.get(_CANDIDATE_KEY_BY_TOOL.get(name, ""), "")
            if not known_url:
                return {
                    "findings": f"No verified {get_tool_label(name)} URL on file for this candidate -- skipping rather than guessing.",
                    "urls": [],
                }
            return _URL_DISPATCH[name](known_url)
        if name == _GITHUB_TOPIC_TOOL:
            known_url = candidate.get("github_url", "")
            if not known_url:
                return {"findings": "No verified GitHub URL on file for this candidate -- skipping rather than guessing.", "urls": []}
            return github_tool.get_github_topic_data(known_url, args.get("topic", ""))
        if name == "get_medium_articles":
            return medium_tool.get_medium_articles(candidate, client=client)
        if name == "get_scholar_papers":
            return scholar_tool.get_scholar_papers(candidate)
        if name == "get_arxiv_papers":
            return arxiv_tool.get_arxiv_papers(candidate)
        if name == _WEB_SEARCH_TOOL:
            return web_search.web_search_tool(client, args.get("query", ""), candidate_name=candidate.get("name"))
        return {"findings": f"Unknown tool requested: {name}", "urls": []}
    except Exception as e:
        return {"findings": f"Tool '{name}' failed: {e}", "urls": []}


# -- Disabled: Gemini tool-selection --
# def _select_tools_gemini(prompt: str, client: Any) -> List[Dict[str, Any]]:
#     resp = client.models.generate_content(
#         model="gemini-2.5-flash",
#         contents=prompt,
#         config=types.GenerateContentConfig(tools=[TOOL_DECLARATIONS], temperature=0.1),
#     )
#     calls: List[Dict[str, Any]] = []
#     resp_candidates = getattr(resp, "candidates", None) or []
#     if not resp_candidates:
#         return calls
#     parts = getattr(resp_candidates[0].content, "parts", None) or []
#     for part in parts:
#         fc = getattr(part, "function_call", None)
#         if fc and getattr(fc, "name", None):
#             calls.append({"name": fc.name, "args": dict(fc.args or {})})
#     return calls


_TOOL_SELECTION_SYSTEM_PROMPT = (
    "You must decide which of the provided tools (if any) to call, and invoke them ONLY via the "
    "tool-calling mechanism -- never describe a call in plain text instead of making it. If a tool "
    "is relevant per the rules in the user message, you must actually invoke it, not just mention it. "
    "If no tool applies, respond with no tool calls."
)


@tracing.observe(as_type="generation", name="openai_select_tools")
def _select_tools_openai(prompt: str, tool_declarations: List[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Tool selection via AICredits (OpenAI-compatible chat completions `tools` param)."""
    client = llm_client._get_openai()
    if client is None:
        raise RuntimeError("OPENAI_API_KEY not set.")
    resp = client.chat.completions.create(
        model=llm_client.OPENAI_MODEL,
        messages=[
            {"role": "system", "content": _TOOL_SELECTION_SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        tools=tool_declarations if tool_declarations is not None else OLLAMA_TOOL_DECLARATIONS,
        temperature=0.1,
    )
    usage = getattr(resp, "usage", None)
    if usage is not None:
        cost = tracing.record_usage(llm_client.OPENAI_MODEL, usage.prompt_tokens, usage.completion_tokens)
        tracing.report_generation_usage(llm_client.OPENAI_MODEL, usage.prompt_tokens, usage.completion_tokens, cost)
    message = resp.choices[0].message
    calls: List[Dict[str, Any]] = []
    for tc in (message.tool_calls or []):
        fn = tc.function
        name = fn.name
        try:
            args = json.loads(fn.arguments or "{}")
        except (json.JSONDecodeError, TypeError):
            args = {}
        if name:
            calls.append({"name": name, "args": args})
    return calls


# -- Disabled: local Ollama tool-selection --
# def _select_tools_ollama(prompt: str) -> List[Dict[str, Any]]:
#     resp = requests.post(
#         f"{llm_client.OLLAMA_BASE_URL}/api/chat",
#         json={
#             "model": llm_client.OLLAMA_MODEL,
#             "messages": [
#                 {"role": "system", "content": _TOOL_SELECTION_SYSTEM_PROMPT},
#                 {"role": "user", "content": prompt},
#             ],
#             "tools": OLLAMA_TOOL_DECLARATIONS,
#             "stream": False,
#             "options": {"temperature": 0.1},
#         },
#         timeout=llm_client.OLLAMA_TIMEOUT,
#     )
#     resp.raise_for_status()
#     message = resp.json().get("message") or {}
#     calls: List[Dict[str, Any]] = []
#     for tc in (message.get("tool_calls") or []):
#         fn = tc.get("function") or {}
#         name = fn.get("name")
#         if name:
#             calls.append({"name": name, "args": fn.get("arguments") or {}})
#     return calls


def select_tools(prompt: str, client: Any = None, tool_declarations: List[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """
    AICredits-only for now, per explicit request: Gemini/Ollama tool-selection
    are disabled above (commented out, not deleted -- uncomment
    _select_tools_gemini/_select_tools_ollama and restore the branch below to
    re-enable). Returns a uniform [{"name": str, "args": dict}, ...] list.
    Raises on failure -- callers own the try/except and any outage fallback
    behavior (e.g. agents.py's deterministic-dispatch fallback).

    tool_declarations: pass AMBIGUOUS_OLLAMA_TOOL_DECLARATIONS to restrict the
    model's choices to only the genuinely judgment-based tools (used by the
    main researcher pass, which calls every known-URL platform deterministically
    and only delegates the ambiguous decisions to the LLM). Defaults to the
    full roster (used by the HITL follow-up, where a human's free-text
    instruction may legitimately name any platform, including ones already
    covered).
    """
    return _select_tools_openai(prompt, tool_declarations=tool_declarations)

    # if llm_client.LLM_PROVIDER == "ollama":
    #     return _select_tools_ollama(prompt)
    # return _select_tools_gemini(prompt, client)


def build_available_links_context(candidate: Dict[str, Any]) -> str:
    """
    Render the candidate's known profile URLs as a context block for the
    tool-selection prompt, e.g.:
        - GitHub: https://github.com/torvalds
        - LinkedIn: not available
        ...
    This is the actual guardrail mechanism: the model is given the real URLs
    to call tools with, and told explicitly which platforms have nothing to
    call at all, rather than having to infer availability itself.
    """
    lines: List[str] = []
    for _name, key, label, _source in _URL_TOOLS:
        value = candidate.get(key)
        lines.append(f"- {label}: {value if value else 'not available'}")
    for _name, key, label, _source in _CANDIDATE_TOOLS:
        if key:
            value = candidate.get(key)
            lines.append(f"- {label}: {value if value else 'not directly linked, but may still be searchable by name'}")
        else:
            lines.append(f"- {label}: searchable by name")
    return "\n".join(lines)
