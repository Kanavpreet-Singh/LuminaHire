"""
LuminaHire — Generic Web Search Tool
======================================
The one deliberately generic tool in the catalog -- reserved for claims no
specific platform tool covers (company/employment verification, general
reputation checks). Two providers:

  1. Gemini Google Search grounding — primary. Uses the existing
     GEMINI_API_KEY via the google-genai SDK.
  2. Tavily Search — retrieval fallback for when Gemini's grounding quota is
     exhausted. Groq (the reasoning-call fallback in llm_client.py) has no
     search tool of its own, so this is what actually keeps web search
     working during a Gemini outage. Set TAVILY_API_KEY to enable; degrades
     gracefully (never raises) if unset.

IMPORTANT SDK constraint: the google_search tool cannot be combined with
response_schema / response_mime_type in the same generate_content call, so the
grounded search returns raw text + source URLs (no structured output here).
"""

import os
from typing import Any, Dict, List, Tuple

import requests
from google.genai import types

GROUNDING_MODEL = "gemini-2.5-flash"
TAVILY_API_URL = "https://api.tavily.com/search"
TAVILY_TIMEOUT = 15
_MAX_CITATIONS_PER_SEARCH = 5
_REDIRECT_RESOLVE_TIMEOUT = 4


def _resolve_grounding_redirect(uri: str) -> str:
    """
    Gemini's Google Search grounding returns citation URLs as
    vertexaisearch.cloud.google.com/grounding-api-redirect/... links, NOT the
    real source URL -- every citation looks like the same unrelated "Vertex
    AI" domain regardless of what was actually found. Follow the redirect
    (HEAD, short timeout) to resolve the real source URL for display/citation.
    Best-effort: on any failure, falls back to the original redirect URL
    (still a valid, clickable link) rather than dropping the citation.
    """
    if not uri or "vertexaisearch.cloud.google.com" not in uri:
        return uri
    try:
        resp = requests.head(uri, allow_redirects=True, timeout=_REDIRECT_RESOLVE_TIMEOUT)
        if resp.url and "vertexaisearch.cloud.google.com" not in resp.url:
            return resp.url
    except requests.exceptions.RequestException:
        pass
    return uri


def is_quota_or_overload_error(exc: Exception) -> bool:
    """
    Detect a Gemini quota/rate-limit/overload error. Google Search grounding
    is Gemini-only (Groq has no equivalent tool), so unlike the reasoning
    calls in llm_client.py there's no provider to fail over to here -- callers
    use this to short-circuit further grounded_search attempts for the rest
    of a research pass instead of repeating an identical failure per query.
    """
    msg = str(exc)
    return any(k in msg for k in ("429", "RESOURCE_EXHAUSTED", "quota", "503", "UNAVAILABLE", "overloaded"))


class QuotaExceededError(Exception):
    """Raised by grounded_search when Gemini's quota/rate limit blocks the call, so
    callers can distinguish it from a genuine "nothing found" NOT_FOUND result."""


def name_match_tier(text: str, candidate_name: str) -> str:
    """
    Classify how strongly text relates to the candidate by name:
      "exact"   -- the candidate's full name appears verbatim.
      "partial" -- some distinctive word from the name appears (e.g. a
                   shared surname), but not the full name -- could be the
                   candidate, could be a different person with an
                   overlapping/similar name.
      "none"    -- no name-based signal at all.
    Generic-keyword web searches (e.g. "Node.js Prisma projects by X") can
    return results that only match on the tech-stack terms -- unrelated
    boilerplate repos, random GitHub issues -- with zero connection to the
    actual person, or results about a *different* real person who happens to
    share part of the name. Callers decide what to do with "partial" --
    reject it (strict) or surface it as an explicitly unconfirmed match.
    """
    if not candidate_name or not text:
        return "exact"  # nothing to check against; don't over-suppress
    text_l = text.lower()
    name_l = candidate_name.strip().lower()
    if name_l and name_l in text_l:
        return "exact"
    parts = [p for p in name_l.split() if len(p) > 2]
    if not parts:
        return "exact"
    return "partial" if any(p in text_l for p in parts) else "none"


def _mentions_candidate(text: str, candidate_name: str) -> bool:
    """Strict relevance guard used by the general web_search_tool path: accepts exact or partial name matches."""
    return name_match_tier(text, candidate_name) != "none"


def grounded_search(client: Any, query: str, linkedin: bool = False, candidate_name: str = None) -> Tuple[str, List[Dict[str, str]]]:
    """
    Run a Google-Search-grounded Gemini query and return (text, urls).
    urls is a list of {"url", "title"} harvested from grounding metadata.

    NOTE: google_search tool cannot be combined with response_schema, so this
    returns free text. Every attribute is None-guarded because grounding
    metadata is absent when grounding does not trigger.

    Raises QuotaExceededError (instead of returning a raw-exception string as
    "findings") when Gemini's quota/rate limit blocks the call, so the caller
    can show a clean message and stop burning further calls against a quota
    that's already exhausted for the day rather than repeating the identical
    failure for every remaining query in the pass.

    If candidate_name is given and the synthesized text never mentions the
    candidate, the result is treated as not-found rather than presented as
    evidence -- a generic keyword search (tech-stack terms + a name) can
    surface real but unrelated pages that only match on the tech terms.
    """
    prompt = query
    if linkedin:
        prompt = f"{query} (check professional profiles such as site:linkedin.com where relevant)"
    prompt = (
        "Research the following and report only verifiable, factual findings with no "
        f"speculation. If nothing credible is found, say so explicitly.\n\n{prompt}"
    )

    try:
        resp = client.models.generate_content(
            model=GROUNDING_MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                tools=[types.Tool(google_search=types.GoogleSearch())],
                temperature=0.0,
            ),
        )
    except Exception as e:
        if is_quota_or_overload_error(e):
            raise QuotaExceededError(str(e)) from e
        return (f"Search failed: {type(e).__name__}: {e}", [])

    text = getattr(resp, "text", None) or ""

    urls: List[Dict[str, str]] = []
    candidates = getattr(resp, "candidates", None) or []
    if candidates:
        gm = getattr(candidates[0], "grounding_metadata", None)
        chunks = getattr(gm, "grounding_chunks", None) or [] if gm else []
        for ch in chunks[:_MAX_CITATIONS_PER_SEARCH]:
            web = getattr(ch, "web", None)
            if web and getattr(web, "uri", None):
                urls.append({"url": _resolve_grounding_redirect(web.uri), "title": getattr(web, "title", "") or ""})

    if candidate_name and text and not _mentions_candidate(text, candidate_name):
        return (
            f'Search for "{query}" returned results, but none clearly referenced {candidate_name} by name -- '
            "treating as not found rather than presenting possibly-unrelated matches.",
            [],
        )

    return text, urls


def tavily_search(query: str, max_results: int = 5, candidate_name: str = None) -> Tuple[str, List[Dict[str, str]]]:
    """
    Real web search via Tavily (https://tavily.com) -- the retrieval fallback
    used when Gemini's Google Search grounding is unavailable (quota
    exhausted). Tavily is purpose-built for LLM/RAG use and returns an
    AI-synthesized `answer` plus source URLs directly in one call, so no
    separate summarization step is needed. Never raises: degrades to an
    explicit "not configured"/"failed" message so the pipeline keeps working
    with whatever else it has (same (text, urls) shape as grounded_search, so
    callers can swap between them without any other changes).

    If candidate_name is given, individual results whose title/content never
    mention the candidate are dropped, and Tavily's synthesized `answer` is
    only trusted if at least one surviving (relevant) result backs it up --
    NOT just because the answer text itself happens to contain the name.
    Tavily's answer synthesis can echo the candidate's name straight from the
    query even when no actual retrieved result supports it (e.g. attributing
    unrelated, purely keyword-matched boilerplate repos to the candidate),
    so checking the answer text alone isn't a reliable relevance signal.
    """
    api_key = os.getenv("TAVILY_API_KEY")
    if not api_key:
        return ("Web search fallback unavailable: TAVILY_API_KEY is not configured.", [])

    try:
        resp = requests.post(
            TAVILY_API_URL,
            json={
                "api_key": api_key,
                "query": query,
                "search_depth": "basic",
                "include_answer": True,
                "max_results": max_results,
            },
            timeout=TAVILY_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
    except requests.exceptions.RequestException as e:
        return (f"Tavily web search failed: {e}", [])
    except ValueError:
        return ("Tavily web search failed: invalid response from Tavily.", [])

    answer = (data.get("answer") or "").strip()
    raw_results = data.get("results") or []

    if candidate_name:
        raw_results = [
            r for r in raw_results
            if _mentions_candidate(f"{r.get('title', '')} {r.get('content', '')}", candidate_name)
        ]
        if not raw_results:
            # Nothing relevant survived -- don't trust the synthesized answer
            # either, even if its text happens to mention the candidate by
            # name (Tavily can echo that straight from the query).
            answer = ""

    urls = [{"url": r["url"], "title": r.get("title", "")} for r in raw_results if r.get("url")]

    if answer:
        text = answer
    elif raw_results:
        # No synthesized answer; fall back to a compact summary of raw snippets.
        text = " ".join((r.get("content") or "")[:200] for r in raw_results[:3]).strip()
    elif candidate_name:
        text = f'No results specific to {candidate_name} were found for this query.'
    else:
        text = ""

    return (text or "No credible results found.", urls)


def web_search_tool(client: Any, query: str, candidate_name: str = None) -> Dict[str, Any]:
    """
    {findings, urls} shape used by the tool-calling researcher. AICredits-only
    for now, per explicit request: Gemini Google Search grounding is disabled
    below (commented out, not deleted) -- Tavily is the sole web-search
    backend while that's the case. `client` is accepted but unused in this
    mode (kept in the signature so call sites don't need to change).
    """
    # -- Disabled: Gemini Google Search grounding, with Tavily as its quota fallback --
    # try:
    #     text, urls = grounded_search(client, query, linkedin=False, candidate_name=candidate_name)
    # except QuotaExceededError:
    #     text, urls = tavily_search(query, candidate_name=candidate_name)
    text, urls = tavily_search(query, candidate_name=candidate_name)
    return {"findings": text, "urls": urls}
