"""
LuminaHire — GeeksforGeeks Tool
================================
Uses the unofficial GFG Stats API (https://gfg-stats.tashif.codes) for
structured data: /{username}/profile (reliable -- confirms identity, real
name, institution) and /{username}/stats (best-effort -- problem-solving
counts; this endpoint frequently times out on the provider's side, likely a
slow upstream scrape, so it's treated as optional and never blocks the
profile result). Falls back to a best-effort generic page scrape whenever
both API calls fail, same degrade-gracefully contract as the rest of this
package.

(An earlier attempt used github.com/arnoob16/GeeksForGeeksAPI, but that
service currently errors even for its own README's example username --
confirmed non-functional as of this writing -- so this replaces it.)
"""

import re
from typing import Any, Dict, List, Optional

import requests

from ._webpage import fetch_and_summarize_webpage

API_BASE = "https://gfg-stats.tashif.codes"
_PROFILE_TIMEOUT = 15
_STATS_TIMEOUT = 8  # short -- /stats frequently 504s; fail fast rather than stall the pass


def _extract_username(url: str) -> Optional[str]:
    match = re.search(r"geeksforgeeks\.org/user/([A-Za-z0-9_-]+)", url, re.IGNORECASE)
    return match.group(1) if match else None


def _get(path: str, timeout: int) -> Optional[Dict[str, Any]]:
    try:
        resp = requests.get(f"{API_BASE}{path}", timeout=timeout)
        if resp.status_code >= 400:
            return None
        data = resp.json()
    except (requests.exceptions.RequestException, ValueError):
        return None
    if not isinstance(data, dict) or data.get("status") != "success":
        return None
    return data.get("data") or None


def get_gfg_data(url: str) -> Dict[str, Any]:
    """Fetch a candidate's GeeksforGeeks profile: structured data via API, falling back to a page scrape."""
    if not url:
        return {"findings": "No GeeksforGeeks URL provided.", "urls": []}

    username = _extract_username(url)
    if username:
        profile = _get(f"/{username}/profile", _PROFILE_TIMEOUT)
        stats = _get(f"/{username}/stats", _STATS_TIMEOUT)  # best-effort, may be None

        if profile:
            lines: List[str] = [f"GeeksforGeeks @{username} ({url}):"]
            if profile.get("displayName"):
                lines.append(f"- Name: {profile.get('displayName')}")
            if profile.get("institution"):
                lines.append(f"- Institution: {profile.get('institution')}")
            if profile.get("company"):
                lines.append(f"- Company: {profile.get('company')}")
            if stats:
                if stats.get("totalSolved") is not None:
                    lines.append(f"- Total problems solved: {stats.get('totalSolved')}")
                difficulty = stats.get("difficultyBreakdown") or stats.get("difficulty")
                if isinstance(difficulty, dict) and difficulty:
                    lines.append("- Difficulty breakdown: " + ", ".join(f"{k}={v}" for k, v in difficulty.items()))
            elif not stats:
                lines.append("- Problem-solving stats temporarily unavailable (provider timeout); identity confirmed above.")
            return {"findings": "\n".join(lines), "urls": [{"url": url, "title": profile.get("displayName") or username}]}

    # API unavailable/errored, or returned no usable fields -- fall back to
    # the best-effort generic page scrape (unchanged from before).
    return fetch_and_summarize_webpage(url)
