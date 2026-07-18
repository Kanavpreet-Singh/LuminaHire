"""
LuminaHire — Dev.to Tool
=========================
Official dev.to REST API (developers.forem.com/api) -- free, no auth needed
for public article reads.
"""

import re
from typing import Any, Dict, List, Optional

import requests

API_BASE = "https://dev.to/api"
_TIMEOUT = 10
_MAX_ARTICLES = 5


def _extract_username(username_or_url: str) -> Optional[str]:
    if not username_or_url:
        return None
    match = re.search(r"dev\.to/([A-Za-z0-9_-]+)", username_or_url, re.IGNORECASE)
    if match:
        return match.group(1)
    if re.match(r"^[A-Za-z0-9_-]+$", username_or_url):
        return username_or_url
    return None


def get_devto_articles(username_or_url: str) -> Dict[str, Any]:
    """Fetch a candidate's recent dev.to articles via the official API."""
    username = _extract_username(username_or_url)
    if not username:
        return {"findings": "No valid dev.to username/URL provided.", "urls": []}

    profile_url = f"https://dev.to/{username}"
    try:
        resp = requests.get(f"{API_BASE}/articles", params={"username": username}, timeout=_TIMEOUT)
        articles = resp.json()
    except (requests.exceptions.RequestException, ValueError) as e:
        return {"findings": f"Dev.to profile identified ({profile_url}), but the API was unreachable: {e}.", "urls": [{"url": profile_url, "title": username}]}

    if not isinstance(articles, list) or not articles:
        return {"findings": f"No dev.to articles found for @{username}.", "urls": [{"url": profile_url, "title": username}]}

    lines: List[str] = [f"Dev.to articles by @{username}:"]
    urls: List[Dict[str, str]] = [{"url": profile_url, "title": username}]
    for article in articles[:_MAX_ARTICLES]:
        title = article.get("title", "Untitled")
        url = article.get("url", "")
        reactions = article.get("public_reactions_count", 0)
        lines.append(f"- {title} ({reactions} reactions)" + (f" [{url}]" if url else ""))
        if url:
            urls.append({"url": url, "title": title})

    return {"findings": "\n".join(lines), "urls": urls}
