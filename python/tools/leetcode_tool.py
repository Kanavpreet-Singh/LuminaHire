"""
LuminaHire — LeetCode Tool
===========================
Uses the public alfa-leetcode-api hosted instance
(https://github.com/alfaarghya/alfa-leetcode-api) -- no auth required.

Reliability note: the public instance runs on Render's free tier, which
cold-starts after inactivity, so the first call in a while can take 30-60s.
A generous timeout is used and failures degrade gracefully (never raise, the
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


def get_leetcode_data(url_or_username: str) -> Dict[str, Any]:
    """Fetch a compact LeetCode profile summary: solved counts, contest rating, top skills/languages, badges."""
    username = _extract_username(url_or_username)
    profile_url = f"https://leetcode.com/u/{username}" if username else url_or_username
    if not username:
        return {"findings": "No valid LeetCode username/URL provided.", "urls": []}

    solved = _get(f"/{username}/solved")
    contest = _get(f"/{username}/contest")
    skill = _get(f"/{username}/skill")
    language = _get(f"/{username}/language")
    badges = _get(f"/{username}/badges")

    # If every single call failed, this profile is unreachable this pass
    # (likely a cold-start timeout or the username doesn't exist).
    if all(isinstance(r, dict) and r.get("error") for r in (solved, contest, skill, language, badges)):
        return {
            "findings": (
                f"LeetCode profile identified at {profile_url}, but the data API was temporarily unreachable "
                "(it cold-starts after inactivity). The link itself is still verifiable evidence."
            ),
            "urls": [{"url": profile_url, "title": username}],
        }

    lines = [f"LeetCode @{username} ({profile_url}):"]

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
            lines.append("- Top skill tags: " + ", ".join(tags[:10]))

    if isinstance(language, dict) and not language.get("error"):
        langs = [l.get("languageName") for l in (language.get("languageProblemCount") or []) if l.get("languageName")]
        if langs:
            lines.append("- Languages used: " + ", ".join(langs[:8]))

    if isinstance(badges, dict) and not badges.get("error"):
        badge_count = len(badges.get("badges") or [])
        if badge_count:
            lines.append(f"- Badges earned: {badge_count}")

    return {"findings": "\n".join(lines), "urls": [{"url": profile_url, "title": username}]}
