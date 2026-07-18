"""
LuminaHire — Stack Overflow Tool
=================================
Official Stack Exchange API v2.3 (api.stackexchange.com) -- free tier, no
auth required for basic reads (an optional app_key raises the rate limit,
not needed at this volume).
"""

import re
from typing import Any, Dict, Optional

import requests

API_BASE = "https://api.stackexchange.com/2.3"
_TIMEOUT = 10


def _extract_user_id(user_id_or_url: str) -> Optional[str]:
    if not user_id_or_url:
        return None
    match = re.search(r"stackoverflow\.com/users/(\d+)", user_id_or_url, re.IGNORECASE)
    if match:
        return match.group(1)
    if re.match(r"^\d+$", user_id_or_url):
        return user_id_or_url
    return None


def get_stackoverflow_data(user_id_or_url: str) -> Dict[str, Any]:
    """Fetch a candidate's Stack Overflow reputation/badges/top tags via the official API."""
    user_id = _extract_user_id(user_id_or_url)
    if not user_id:
        return {"findings": "No valid Stack Overflow user ID/URL provided.", "urls": []}

    profile_url = f"https://stackoverflow.com/users/{user_id}"
    try:
        resp = requests.get(f"{API_BASE}/users/{user_id}", params={"site": "stackoverflow"}, timeout=_TIMEOUT)
        data = resp.json()
    except (requests.exceptions.RequestException, ValueError) as e:
        return {"findings": f"Stack Overflow profile identified ({profile_url}), but the API was unreachable: {e}.", "urls": [{"url": profile_url, "title": ""}]}

    items = data.get("items") or []
    if not items:
        return {"findings": f"No Stack Overflow user found for ID {user_id}.", "urls": []}

    user = items[0]
    display_name = user.get("display_name", "")
    lines = [f"Stack Overflow: {display_name} ({profile_url}):"]
    lines.append(
        f"- Reputation: {user.get('reputation', 'N/A')}; "
        f"Badges: gold={user.get('badge_counts', {}).get('gold', 0)}, "
        f"silver={user.get('badge_counts', {}).get('silver', 0)}, "
        f"bronze={user.get('badge_counts', {}).get('bronze', 0)}"
    )

    try:
        tags_resp = requests.get(f"{API_BASE}/users/{user_id}/top-answer-tags", params={"site": "stackoverflow"}, timeout=_TIMEOUT)
        tags_data = tags_resp.json()
        tags = [t.get("tag_name") for t in (tags_data.get("items") or [])[:8] if t.get("tag_name")]
        if tags:
            lines.append("- Top answer tags: " + ", ".join(tags))
    except (requests.exceptions.RequestException, ValueError):
        pass  # tag breakdown is a bonus, not required for a useful finding

    return {"findings": "\n".join(lines), "urls": [{"url": profile_url, "title": display_name}]}
