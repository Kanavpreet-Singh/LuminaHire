"""
LuminaHire — Research Tools
===========================
Real data-gathering tools used by the Researcher Agent. No LLM judgment here;
these functions return raw, verifiable facts with source URLs so the Evaluator
can cite evidence.

  1. GitHub REST API v3  — public profile / repos / languages / activity.
     Unauthenticated by default (60 req/hr/IP); set GITHUB_TOKEN to raise to 5000/hr.
  2. Gemini Google Search grounding — web/company/LinkedIn-adjacent research.
     Uses the existing GEMINI_API_KEY via the google-genai SDK.

IMPORTANT SDK constraint: the google_search tool cannot be combined with
response_schema / response_mime_type in the same generate_content call, so the
grounded search returns raw text + source URLs (no structured output here).
"""

import os
import re
from typing import Any, Dict, List, Optional, Tuple

import requests
from google.genai import types

GITHUB_API = "https://api.github.com"
GITHUB_TIMEOUT = 15
GROUNDING_MODEL = "gemini-2.5-flash"


# ── GitHub REST tools ─────────────────────────────────────────

def _gh_headers() -> Dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "LuminaHire-Research-Agent",
    }
    token = os.getenv("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def extract_github_username(github_url: Optional[str]) -> Optional[str]:
    """Pull the username out of a github.com/<user> URL. Returns None if not parseable."""
    if not github_url:
        return None
    match = re.search(r"github\.com/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)", github_url)
    if not match:
        return None
    username = match.group(1)
    # Skip reserved/non-user paths that sometimes appear in pasted URLs.
    if username.lower() in {"orgs", "settings", "about", "features", "pricing"}:
        return None
    return username


def _gh_get(path: str, params: Optional[Dict[str, Any]] = None) -> Any:
    """
    GET a GitHub API path. Returns parsed JSON, or a dict {"error": ...} on
    rate-limit / not-found / network failure (never raises) so the pipeline
    degrades gracefully instead of crashing.
    """
    try:
        resp = requests.get(
            f"{GITHUB_API}{path}",
            headers=_gh_headers(),
            params=params,
            timeout=GITHUB_TIMEOUT,
        )
    except requests.exceptions.RequestException as e:
        return {"error": "network", "detail": str(e)}

    if resp.status_code == 404:
        return {"error": "not_found"}
    if resp.status_code == 403 and resp.headers.get("X-RateLimit-Remaining") == "0":
        return {"error": "rate_limited", "reset": resp.headers.get("X-RateLimit-Reset")}
    if resp.status_code >= 400:
        return {"error": "http", "status": resp.status_code}
    try:
        return resp.json()
    except ValueError:
        return {"error": "invalid_json"}


def fetch_github_bundle(username: str) -> Dict[str, Any]:
    """
    Gather a compact, factual snapshot of a public GitHub user in <= ~8 requests.
    All findings are deterministic (no LLM). Repo html_urls are included so the
    Evaluator can cite them as evidence.
    """
    bundle: Dict[str, Any] = {"username": username, "html_url": f"https://github.com/{username}"}

    profile = _gh_get(f"/users/{username}")
    if isinstance(profile, dict) and profile.get("error"):
        bundle["error"] = profile["error"]
        return bundle

    bundle["profile"] = {
        "name": profile.get("name"),
        "bio": profile.get("bio"),
        "company": profile.get("company"),
        "location": profile.get("location"),
        "public_repos": profile.get("public_repos"),
        "followers": profile.get("followers"),
        "following": profile.get("following"),
        "created_at": profile.get("created_at"),
        "html_url": profile.get("html_url"),
    }

    repos = _gh_get(f"/users/{username}/repos", params={"sort": "pushed", "per_page": 10})
    repo_list: List[Dict[str, Any]] = []
    top_non_forks: List[str] = []
    if isinstance(repos, list):
        for r in repos:
            is_fork = bool(r.get("fork"))
            repo_list.append({
                "name": r.get("name"),
                "description": r.get("description"),
                "language": r.get("language"),
                "stars": r.get("stargazers_count"),
                "forks": r.get("forks_count"),
                "is_fork": is_fork,
                "pushed_at": r.get("pushed_at"),
                "html_url": r.get("html_url"),
            })
            if not is_fork and len(top_non_forks) < 5:
                top_non_forks.append(r.get("name"))
    bundle["repos"] = repo_list

    # Languages for up to 5 top non-fork repos (keeps request budget bounded).
    languages: Dict[str, int] = {}
    for repo_name in top_non_forks:
        lang_data = _gh_get(f"/repos/{username}/{repo_name}/languages")
        if isinstance(lang_data, dict) and not lang_data.get("error"):
            for lang, byte_count in lang_data.items():
                languages[lang] = languages.get(lang, 0) + int(byte_count)
    bundle["languages"] = dict(sorted(languages.items(), key=lambda kv: kv[1], reverse=True))

    # Recent public activity, aggregated by event type.
    events = _gh_get(f"/users/{username}/events/public", params={"per_page": 30})
    activity: Dict[str, int] = {}
    if isinstance(events, list):
        for ev in events:
            etype = ev.get("type", "Unknown")
            activity[etype] = activity.get(etype, 0) + 1
    bundle["recent_activity"] = activity

    return bundle


def summarize_github_bundle(bundle: Dict[str, Any]) -> str:
    """Turn a GitHub bundle into a compact factual string for the research findings."""
    if bundle.get("error"):
        return f"GitHub lookup for {bundle.get('username')} failed: {bundle['error']}."

    p = bundle.get("profile", {})
    lines = [
        f"GitHub @{bundle.get('username')} ({p.get('html_url')}):",
        f"- Name: {p.get('name') or 'N/A'}; Bio: {p.get('bio') or 'N/A'}; "
        f"Company: {p.get('company') or 'N/A'}; Location: {p.get('location') or 'N/A'}",
        f"- Public repos: {p.get('public_repos')}; Followers: {p.get('followers')}; "
        f"Member since: {p.get('created_at')}",
    ]
    langs = bundle.get("languages") or {}
    if langs:
        lines.append("- Top languages (by bytes): " + ", ".join(list(langs.keys())[:8]))
    repos = [r for r in bundle.get("repos", []) if not r.get("is_fork")]
    if repos:
        lines.append("- Notable non-fork repos:")
        for r in repos[:6]:
            lines.append(
                f"  * {r.get('name')} ({r.get('language') or 'N/A'}, "
                f"{r.get('stars', 0)} stars) - {r.get('description') or 'no description'} [{r.get('html_url')}]"
            )
    activity = bundle.get("recent_activity") or {}
    if activity:
        lines.append("- Recent activity: " + ", ".join(f"{k}={v}" for k, v in activity.items()))
    return "\n".join(lines)


def github_repo_urls(bundle: Dict[str, Any]) -> List[str]:
    """Collect citable URLs from a GitHub bundle (profile + non-fork repos)."""
    urls: List[str] = []
    p = bundle.get("profile", {})
    if p.get("html_url"):
        urls.append(p["html_url"])
    for r in bundle.get("repos", []):
        if not r.get("is_fork") and r.get("html_url"):
            urls.append(r["html_url"])
    return urls


def github_topic_search_tool(username: str, topic: str) -> Dict[str, Any]:
    """
    Search a specific GitHub user's repositories for a topic/keyword (e.g. "MERN
    stack", "machine learning") using the GitHub Search API. Deterministic, no
    LLM judgment. Degrades gracefully (never raises) like the rest of this module.
    """
    query = f"user:{username} {topic} in:name,description,readme"
    data = _gh_get("/search/repositories", params={"q": query, "per_page": 5})

    if isinstance(data, dict) and data.get("error"):
        return {
            "findings": f"GitHub topic search for '{topic}' on @{username} failed: {data['error']}.",
            "urls": [],
        }

    items = data.get("items") if isinstance(data, dict) else None
    if not items:
        return {
            "findings": f"No repositories matching '{topic}' were found for @{username}.",
            "urls": [],
        }

    lines = [f"GitHub repositories for @{username} matching '{topic}':"]
    urls: List[Dict[str, str]] = []
    for repo in items[:5]:
        name = repo.get("name")
        desc = repo.get("description") or "no description"
        lang = repo.get("language") or "N/A"
        stars = repo.get("stargazers_count", 0)
        html_url = repo.get("html_url")
        lines.append(f"- {name} ({lang}, {stars} stars): {desc} [{html_url}]")
        if html_url:
            urls.append({"url": html_url, "title": name or ""})

    return {"findings": "\n".join(lines), "urls": urls}


# ── Gemini grounded web search ────────────────────────────────

def grounded_search(client: Any, query: str, linkedin: bool = False) -> Tuple[str, List[Dict[str, str]]]:
    """
    Run a Google-Search-grounded Gemini query and return (text, urls).
    urls is a list of {"url", "title"} harvested from grounding metadata.

    NOTE: google_search tool cannot be combined with response_schema, so this
    returns free text. Every attribute is None-guarded because grounding
    metadata is absent when grounding does not trigger.
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
        return (f"Search failed: {e}", [])

    text = getattr(resp, "text", None) or ""

    urls: List[Dict[str, str]] = []
    candidates = getattr(resp, "candidates", None) or []
    if candidates:
        gm = getattr(candidates[0], "grounding_metadata", None)
        chunks = getattr(gm, "grounding_chunks", None) or [] if gm else []
        for ch in chunks:
            web = getattr(ch, "web", None)
            if web and getattr(web, "uri", None):
                urls.append({"url": web.uri, "title": getattr(web, "title", "") or ""})

    return text, urls


def web_search_tool(client: Any, query: str) -> Dict[str, Any]:
    """Thin wrapper around grounded_search() in the {findings, urls} shape used by the tool-calling researcher."""
    text, urls = grounded_search(client, query, linkedin=False)
    return {"findings": text, "urls": urls}


def github_profile_tool(username: str) -> Dict[str, Any]:
    """Fetch and summarize a GitHub profile in the {findings, urls} shape used by the tool-calling researcher."""
    bundle = fetch_github_bundle(username)
    return {"findings": summarize_github_bundle(bundle), "urls": [{"url": u, "title": ""} for u in github_repo_urls(bundle)]}


# ── Smoke test ────────────────────────────────────────────────
if __name__ == "__main__":
    import json
    from dotenv import load_dotenv
    load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

    print("=== GitHub bundle (torvalds) ===")
    b = fetch_github_bundle("torvalds")
    print(summarize_github_bundle(b))
    print("citable urls:", github_repo_urls(b)[:3])

    print("\n=== Grounded search ===")
    from google import genai
    client = genai.Client()
    txt, srcs = grounded_search(client, "What is the LangGraph library used for in Python?")
    print(txt[:400])
    print("sources:", json.dumps(srcs[:3], indent=2))
