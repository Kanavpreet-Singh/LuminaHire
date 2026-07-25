"""
LuminaHire — LeetCode Tool
===========================
Primary source is a direct scrape of the profile page
(leetcode.com/u/{username}/): it's server-rendered by Next.js (Pages Router),
so the initial GraphQL result for the profile query is inlined as JSON in a
`<script id="__NEXT_DATA__">` tag -- no auth, no third-party dependency, no
cold-start. That query (`userPublicProfile`) covers identity/reputation
fields (real name, ranking, reputation, country, company, skill tags,
contest badge) but not problem-solved counts or contest rating, which the
profile page fetches client-side after load and so aren't in the initial
payload.

For those, this still calls the public alfa-leetcode-api hosted instance
(https://github.com/alfaarghya/alfa-leetcode-api) as a best-effort
enrichment -- same as before, degrades gracefully (never raises, the profile
URL is still cited as evidence) rather than blocking the whole pass. It runs
on Render's free tier and cold-starts after inactivity, hence the generous
timeout.
"""

import json
import re
from typing import Any, Dict, List, Optional

import requests

API_BASE = "https://alfa-leetcode-api.onrender.com"
_API_TIMEOUT = 25

_PAGE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
}
_PAGE_TIMEOUT = 15
_NEXT_DATA_RE = re.compile(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', re.S)


def _extract_username(url_or_username: str) -> Optional[str]:
    if not url_or_username:
        return None
    match = re.search(r"leetcode\.com/(?:u/)?([A-Za-z0-9_-]+)", url_or_username, re.IGNORECASE)
    if match:
        return match.group(1)
    if re.match(r"^[A-Za-z0-9_-]+$", url_or_username):
        return url_or_username
    return None


def _get(path: str) -> Any:
    try:
        resp = requests.get(f"{API_BASE}{path}", timeout=_API_TIMEOUT)
    except requests.exceptions.RequestException as e:
        return {"error": str(e)}
    if resp.status_code >= 400:
        return {"error": f"HTTP {resp.status_code}"}
    try:
        return resp.json()
    except ValueError:
        return {"error": "invalid_json"}


def _scrape_profile_page(username: str) -> Optional[Dict[str, Any]]:
    """Pull the server-rendered `userPublicProfile` query result out of __NEXT_DATA__."""
    try:
        resp = requests.get(f"https://leetcode.com/u/{username}/", headers=_PAGE_HEADERS, timeout=_PAGE_TIMEOUT)
    except requests.exceptions.RequestException:
        return None
    if resp.status_code >= 400:
        return None

    match = _NEXT_DATA_RE.search(resp.text)
    if not match:
        return None
    try:
        next_data = json.loads(match.group(1))
    except (json.JSONDecodeError, ValueError):
        return None

    queries = (
        next_data.get("props", {})
        .get("pageProps", {})
        .get("dehydratedState", {})
        .get("queries", [])
    )
    for q in queries:
        key = q.get("queryKey") or []
        if key and key[0] == "userPublicProfile":
            return (q.get("state", {}).get("data") or {}).get("matchedUser")
    return None


def get_leetcode_data(url_or_username: str) -> Dict[str, Any]:
    """Fetch a compact LeetCode profile summary: identity/reputation via page scrape, solved/contest/skill/language/badges via best-effort API."""
    username = _extract_username(url_or_username)
    profile_url = f"https://leetcode.com/u/{username}" if username else url_or_username
    if not username:
        return {"findings": "No valid LeetCode username/URL provided.", "urls": []}

    scraped = _scrape_profile_page(username)

    solved = _get(f"/{username}/solved")
    contest = _get(f"/{username}/contest")
    skill = _get(f"/{username}/skill")
    language = _get(f"/{username}/language")
    badges = _get(f"/{username}/badges")
    api_reachable = not all(isinstance(r, dict) and r.get("error") for r in (solved, contest, skill, language, badges))

    if not scraped and not api_reachable:
        return {
            "findings": (
                f"LeetCode profile identified at {profile_url}, but it could not be scraped and the data API was "
                "temporarily unreachable (it cold-starts after inactivity). The link itself is still verifiable evidence."
            ),
            "urls": [{"url": profile_url, "title": username}],
            # Keep the contract identical on every return path: callers should
            # never have to branch on whether these keys happen to exist.
            "identity": {"name": None, "handle": username},
            "scrape_blocked": True,
            "error": "unreachable",
        }

    lines = [f"LeetCode @{username} ({profile_url}):"]

    if scraped:
        profile = scraped.get("profile") or {}
        if profile.get("realName"):
            lines.append(f"- Name: {profile.get('realName')}")
        if profile.get("ranking"):
            lines.append(f"- Global ranking: {profile.get('ranking')}")
        if profile.get("countryName"):
            lines.append(f"- Country: {profile.get('countryName')}")
        if profile.get("company"):
            lines.append(f"- Company: {profile.get('company')}")
        if profile.get("reputation") is not None:
            lines.append(f"- Reputation: {profile.get('reputation')}")
        if profile.get("skillTags"):
            lines.append("- Self-reported skills: " + ", ".join(profile.get("skillTags")[:10]))
        badge = scraped.get("contestBadge")
        if badge and badge.get("name"):
            lines.append(f"- Contest badge: {badge.get('name')}")

    if isinstance(solved, dict) and not solved.get("error"):
        lines.append(
            f"- Solved: {solved.get('solvedProblem', 'N/A')} total "
            f"(Easy {solved.get('easySolved', 'N/A')}, Medium {solved.get('mediumSolved', 'N/A')}, Hard {solved.get('hardSolved', 'N/A')})"
        )

    if isinstance(contest, dict) and not contest.get("error") and contest.get("contestRating"):
        lines.append(
            f"- Contest rating: {contest.get('contestRating')} "
            f"(top {contest.get('contestTopPercentage', 'N/A')}%, {contest.get('contestAttend', 'N/A')} contests attended)"
        )

    if isinstance(skill, dict) and not skill.get("error"):
        tags: List[str] = []
        for bucket in ("advanced", "intermediate", "fundamental"):
            for item in (skill.get(bucket) or [])[:5]:
                tag_name = item.get("tagName")
                if tag_name:
                    tags.append(tag_name)
        if tags:
            lines.append("- Top skill tags (by problems solved): " + ", ".join(tags[:10]))

    if isinstance(language, dict) and not language.get("error"):
        langs = [l.get("languageName") for l in (language.get("languageProblemCount") or []) if l.get("languageName")]
        if langs:
            lines.append("- Languages used: " + ", ".join(langs[:8]))

    if isinstance(badges, dict) and not badges.get("error"):
        badge_count = len(badges.get("badges") or [])
        if badge_count:
            lines.append(f"- Badges earned: {badge_count}")

    real_name = ((scraped or {}).get("profile") or {}).get("realName")
    return {
        "findings": "\n".join(lines),
        "urls": [{"url": profile_url, "title": username}],
        "identity": {"name": real_name, "handle": username},
        # Cloudflare blocks the page scrape often enough that the distinction
        # matters downstream: no identity data because the profile hides its
        # name is a different situation from no identity data because we were
        # blocked, and only the latter is worth telling the recruiter about.
        "scrape_blocked": scraped is None,
    }
