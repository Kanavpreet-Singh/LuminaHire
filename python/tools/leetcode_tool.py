"""
LuminaHire — LeetCode Tool
===========================
Uses the public alfa-leetcode-api hosted instance
(https://github.com/alfaarghya/alfa-leetcode-api) exclusively -- no auth, no
scraping.

WHY THERE IS NO PAGE SCRAPE HERE
---------------------------------
An earlier version scraped leetcode.com/u/{username} for the profile's real
name and ranking, because those fields aren't in the solved/contest
endpoints. leetcode.com sits behind Cloudflare, which serves a JS challenge
to automated clients: in testing the scrape started returning HTTP 403 after
a handful of requests, so under a real batch run it would fail for most
candidates and add a "partial read" caveat to nearly every LeetCode finding.

The API's `/{username}` endpoint turns out to cover the same ground --
name, ranking, reputation, country, company, school, skill tags -- so the
scrape bought nothing but a Cloudflare dependency. Dropping it makes this
tool's behaviour uniform instead of intermittently degraded.

Reliability note: the public instance runs on Render's free tier, which
cold-starts after inactivity, so the first call in a while can take 30-60s.
A generous timeout is used and failures degrade gracefully (never raise; the
profile URL is still cited as evidence) rather than blocking the whole pass.
"""

import re
from typing import Any, Dict, List, Optional

import requests

API_BASE = "https://alfa-leetcode-api.onrender.com"
_TIMEOUT = 25


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
        resp = requests.get(f"{API_BASE}{path}", timeout=_TIMEOUT)
    except requests.exceptions.RequestException as e:
        return {"error": str(e)}
    if resp.status_code >= 400:
        return {"error": f"HTTP {resp.status_code}"}
    try:
        return resp.json()
    except ValueError:
        return {"error": "invalid_json"}


def _ok(payload: Any) -> bool:
    return isinstance(payload, dict) and not payload.get("error")


def get_leetcode_data(url_or_username: str) -> Dict[str, Any]:
    """Fetch a compact LeetCode profile summary: identity, solved counts, contest rating, skills, languages, badges."""
    username = _extract_username(url_or_username)
    profile_url = f"https://leetcode.com/u/{username}" if username else url_or_username
    if not username:
        return {"findings": "No valid LeetCode username/URL provided.", "urls": []}

    profile = _get(f"/{username}")
    solved = _get(f"/{username}/solved")
    contest = _get(f"/{username}/contest")
    skill = _get(f"/{username}/skill")
    language = _get(f"/{username}/language")
    badges = _get(f"/{username}/badges")

    responses = (profile, solved, contest, skill, language, badges)
    # Every call failing means the API is down or cold-starting -- a fetch
    # failure, not a statement about the candidate. The `error` key makes the
    # caller report UNREACHABLE instead of scoring this as a real check.
    if not any(_ok(r) for r in responses):
        return {
            "findings": (
                f"LeetCode profile identified at {profile_url}, but the data API was unreachable "
                "(it cold-starts after inactivity). The link itself is still verifiable evidence."
            ),
            "urls": [{"url": profile_url, "title": username}],
            "identity": {"name": None, "handle": username},
            "error": "unreachable",
        }

    lines = [f"LeetCode @{username} ({profile_url}):"]
    real_name = None

    if _ok(profile):
        real_name = profile.get("name")
        if real_name:
            lines.append(f"- Name: {real_name}")
        if profile.get("ranking"):
            lines.append(f"- Global ranking: {profile.get('ranking')}")
        if profile.get("country"):
            lines.append(f"- Country: {profile.get('country')}")
        if profile.get("company"):
            lines.append(f"- Company: {profile.get('company')}")
        if profile.get("school"):
            lines.append(f"- School: {profile.get('school')}")
        if profile.get("reputation"):
            lines.append(f"- Reputation: {profile.get('reputation')}")
        if profile.get("skillTags"):
            lines.append("- Self-reported skills: " + ", ".join(profile["skillTags"][:10]))

    if _ok(solved):
        lines.append(
            f"- Solved: {solved.get('solvedProblem', 'N/A')} total "
            f"(Easy {solved.get('easySolved', 'N/A')}, Medium {solved.get('mediumSolved', 'N/A')}, "
            f"Hard {solved.get('hardSolved', 'N/A')})"
        )

    if _ok(contest) and contest.get("contestRating"):
        lines.append(
            f"- Contest rating: {round(contest['contestRating'])} "
            f"(top {contest.get('contestTopPercentage', 'N/A')}%, "
            f"{contest.get('contestAttend', 'N/A')} contests attended)"
        )
        badge_name = (contest.get("contestBadges") or {}).get("name")
        if badge_name:
            lines.append(f"- Contest badge: {badge_name}")

    if _ok(skill):
        tags: List[str] = []
        for bucket in ("advanced", "intermediate", "fundamental"):
            for item in (skill.get(bucket) or [])[:5]:
                if item.get("tagName"):
                    tags.append(item["tagName"])
        if tags:
            lines.append("- Top skill tags (by problems solved): " + ", ".join(tags[:10]))

    if _ok(language):
        langs = [l.get("languageName") for l in (language.get("languageProblemCount") or []) if l.get("languageName")]
        if langs:
            lines.append("- Languages used: " + ", ".join(langs[:8]))

    if _ok(badges):
        badge_count = len(badges.get("badges") or [])
        if badge_count:
            lines.append(f"- Badges earned: {badge_count}")

    return {
        "findings": "\n".join(lines),
        "urls": [{"url": profile_url, "title": username}],
        # `handle` lets the caller recognise a name that is really just the
        # username -- LeetCode's default when no real name is set -- and skip
        # the identity comparison rather than reporting a false mismatch.
        "identity": {"name": real_name, "handle": username},
    }
