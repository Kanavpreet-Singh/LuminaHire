"""
LuminaHire — Codeforces Tool
=============================
Uses Codeforces' official public API (codeforces.com/apiHelp) -- no auth
needed, no scraping. Reliable JSON, upgraded from the generic-scrape
handling this platform used to get.
"""

import re
from typing import Any, Dict, Optional

import requests

API_BASE = "https://codeforces.com/api"
_TIMEOUT = 12


def _extract_handle(handle_or_url: str) -> Optional[str]:
    if not handle_or_url:
        return None
    match = re.search(r"codeforces\.com/profile/([A-Za-z0-9_-]+)", handle_or_url, re.IGNORECASE)
    if match:
        return match.group(1)
    if re.match(r"^[A-Za-z0-9_-]+$", handle_or_url):
        return handle_or_url
    return None


def get_codeforces_data(handle_or_url: str) -> Dict[str, Any]:
    """Fetch a candidate's Codeforces rank/rating/contest history via the official API."""
    handle = _extract_handle(handle_or_url)
    profile_url = f"https://codeforces.com/profile/{handle}" if handle else handle_or_url
    if not handle:
        return {"findings": "No valid Codeforces handle/URL provided.", "urls": []}

    try:
        info_resp = requests.get(f"{API_BASE}/user.info", params={"handles": handle}, timeout=_TIMEOUT)
        info_data = info_resp.json()
    except (requests.exceptions.RequestException, ValueError) as e:
        return {"findings": f"Codeforces profile identified at {profile_url}, but the API was unreachable: {e}.", "urls": [{"url": profile_url, "title": handle}]}

    if info_data.get("status") != "OK" or not info_data.get("result"):
        return {"findings": f"No Codeforces user found for handle '{handle}'.", "urls": []}

    user = info_data["result"][0]
    lines = [f"Codeforces @{handle} ({profile_url}):"]
    lines.append(
        f"- Rank: {user.get('rank', 'unrated')}; Rating: {user.get('rating', 'N/A')} "
        f"(max: {user.get('maxRating', 'N/A')}, max rank: {user.get('maxRank', 'N/A')})"
    )
    if user.get("contribution") is not None:
        lines.append(f"- Contribution: {user.get('contribution')}")

    try:
        rating_resp = requests.get(f"{API_BASE}/user.rating", params={"handle": handle}, timeout=_TIMEOUT)
        rating_data = rating_resp.json()
        if rating_data.get("status") == "OK":
            contest_count = len(rating_data.get("result") or [])
            if contest_count:
                lines.append(f"- Rated contests participated: {contest_count}")
    except (requests.exceptions.RequestException, ValueError):
        pass  # rating history is a bonus, not required for a useful finding

    return {"findings": "\n".join(lines), "urls": [{"url": profile_url, "title": handle}]}
