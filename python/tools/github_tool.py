"""
LuminaHire — GitHub Tool
=========================
Public GitHub REST API v3 — profile / repos / languages / activity.
Unauthenticated by default (60 req/hr/IP); set GITHUB_TOKEN to raise to 5000/hr.
No LLM judgment here; returns raw, verifiable facts with source URLs.
"""

import os
import re
from typing import Any, Dict, List, Optional

import requests

GITHUB_API = "https://api.github.com"
GITHUB_TIMEOUT = 15
MAX_REPO_PAGES = 3          # per_page=100 x 3 = up to 300 repos scanned (vs. the old hardcoded 10) -- covers the vast majority of candidates without unbounded pagination
MAX_LANGUAGE_REPOS = 12     # bounded /repos/languages calls per candidate -- protects the 60/hr unauthenticated rate limit; set GITHUB_TOKEN (5000/hr) for reliable use at this scale
MIN_REPO_SIZE_KB = 1        # excludes literally-empty scaffold repos (size 0) from the tech-stack ranking, not small-but-real projects


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


def _fetch_all_repos(username: str) -> List[Dict[str, Any]]:
    """
    Paginate through a user's public repos (up to MAX_REPO_PAGES x 100), instead
    of only the 10 most-recently-pushed. A candidate's biggest/most substantive
    project is frequently not their most recently touched one, so the old
    per_page=10 cutoff silently dropped it from the tech-stack analysis below.
    """
    all_repos: List[Dict[str, Any]] = []
    for page in range(1, MAX_REPO_PAGES + 1):
        batch = _gh_get(f"/users/{username}/repos", params={"sort": "pushed", "per_page": 100, "page": page})
        if not isinstance(batch, list) or not batch:
            break
        all_repos.extend(batch)
        if len(batch) < 100:
            break
    return all_repos


def fetch_github_bundle(username: str) -> Dict[str, Any]:
    """
    Gather a compact, factual snapshot of a public GitHub user. All findings
    are deterministic (no LLM). Repo html_urls are included so the Evaluator
    can cite them as evidence.
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

    all_repos = _fetch_all_repos(username)
    repo_list: List[Dict[str, Any]] = []
    for r in all_repos:
        repo_list.append({
            "name": r.get("name"),
            "description": r.get("description"),
            "language": r.get("language"),
            "size_kb": r.get("size") or 0,
            "stars": r.get("stargazers_count"),
            "forks": r.get("forks_count"),
            "is_fork": bool(r.get("fork")),
            "pushed_at": r.get("pushed_at"),
            "html_url": r.get("html_url"),
        })
    bundle["repos"] = repo_list
    bundle["total_repos_scanned"] = len(repo_list)

    # Rank OWN (non-fork) repos by size -- a field already returned by the
    # repos-list call above, at zero extra request cost -- so the biggest,
    # most substantive projects drive the tech-stack read instead of whatever
    # was most recently pushed. A fork inherits the upstream repo's full
    # size/history rather than reflecting the candidate's own code, so forks
    # are excluded from both this ranking and the /languages calls below.
    non_forks = [r for r in repo_list if not r["is_fork"] and r["size_kb"] >= MIN_REPO_SIZE_KB]
    non_forks_by_size = sorted(non_forks, key=lambda r: r["size_kb"], reverse=True)
    top_by_size = non_forks_by_size[:MAX_LANGUAGE_REPOS]
    bundle["non_fork_repo_count"] = len(non_forks)

    # Per-language byte breakdown for the largest non-fork repos only (bounded
    # request budget -- see MAX_LANGUAGE_REPOS). GitHub's REST API has no
    # literal "lines of code" endpoint (that requires cloning + a tool like
    # cloc); /languages' byte-per-language counts are the same proxy GitHub's
    # own repo-page language bar uses. Those bytes are themselves roughly
    # proportional to a repo's size, so simply summing raw bytes across the
    # biggest repos already yields a size-weighted tech-stack profile --
    # a big real project naturally outweighs a tiny toy repo without any
    # extra weighting formula.
    language_bytes: Dict[str, int] = {}
    analyzed_repos: List[str] = []
    for repo in top_by_size:
        lang_data = _gh_get(f"/repos/{username}/{repo['name']}/languages")
        if isinstance(lang_data, dict) and not lang_data.get("error"):
            analyzed_repos.append(repo["name"])
            for lang, byte_count in lang_data.items():
                language_bytes[lang] = language_bytes.get(lang, 0) + int(byte_count)

    total_bytes = sum(language_bytes.values())
    tech_stack = [
        {"language": lang, "bytes": count, "percent": round(count / total_bytes * 100, 1) if total_bytes else 0.0}
        for lang, count in sorted(language_bytes.items(), key=lambda kv: kv[1], reverse=True)
    ]
    bundle["languages"] = {t["language"]: t["bytes"] for t in tech_stack}  # back-compat shape
    bundle["tech_stack"] = tech_stack
    bundle["repos_analyzed_for_tech_stack"] = analyzed_repos

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

    total_scanned = bundle.get("total_repos_scanned", 0)
    non_fork_count = bundle.get("non_fork_repo_count", 0)
    analyzed = bundle.get("repos_analyzed_for_tech_stack") or []
    tech_stack = bundle.get("tech_stack") or []
    if tech_stack:
        lines.append(
            f"- Tech stack by code volume (bytes of code across the {len(analyzed)} largest of "
            f"{non_fork_count} original, non-fork repos out of {total_scanned} public repos scanned -- "
            f"weighted by project size, not recency, so small toy repos don't outrank real projects):"
        )
        for t in tech_stack[:8]:
            lines.append(f"  * {t['language']}: {t['percent']}%")

    repos = [r for r in bundle.get("repos", []) if not r.get("is_fork")]
    repos_by_size = sorted(repos, key=lambda r: r.get("size_kb") or 0, reverse=True)
    if repos_by_size:
        lines.append("- Largest original projects (ranked by repo size, not recency):")
        for r in repos_by_size[:6]:
            lines.append(
                f"  * {r.get('name')} ({r.get('language') or 'N/A'}, {r.get('size_kb', 0)} KB, "
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


def get_github_data(username_or_url: str) -> Dict[str, Any]:
    """Fetch and summarize a GitHub profile in the {findings, urls} shape used by the ReAct researcher."""
    username = extract_github_username(username_or_url) or username_or_url
    if not username:
        return {"findings": "No valid GitHub username/URL provided.", "urls": []}
    bundle = fetch_github_bundle(username)
    return {"findings": summarize_github_bundle(bundle), "urls": [{"url": u, "title": ""} for u in github_repo_urls(bundle)]}


def get_github_topic_data(username_or_url: str, topic: str) -> Dict[str, Any]:
    """
    Search a specific GitHub user's repositories for a topic/keyword (e.g. "MERN
    stack", "machine learning") using the GitHub Search API. Deterministic, no
    LLM judgment. Degrades gracefully (never raises) like the rest of this module.
    """
    username = extract_github_username(username_or_url) or username_or_url
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


# Backward-compat aliases (used internally + kept for anything referencing old names)
github_topic_search_tool = get_github_topic_data
github_profile_tool = get_github_data
