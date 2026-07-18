"""
LuminaHire — Medium Tool
=========================
Medium publishes a per-user RSS feed at medium.com/feed/@username -- an
official, reliable, no-auth feature, so this needs no scraping when a Medium
URL is known. If the candidate has no known Medium URL, falls back to a
generic web search for their technical writing (the one tool in the catalog
with this explicit two-tier behavior, since Medium articles are sometimes
never linked directly but still findable by name).

The web-search fallback is deliberately more lenient than the general
web_search_tool's relevance filter: a same-surname-but-different-person match
is shown, not silently dropped -- but always labeled by confidence tier
(name_match_tier: exact vs. partial) so a recruiter can judge it themselves
rather than the tool either hiding a real match or silently misattributing a
stranger's writing to the candidate.
"""

import re
import xml.etree.ElementTree as ET
from typing import Any, Dict, List, Optional

import requests

from . import web_search

_TIMEOUT = 10
_MAX_ARTICLES = 5


def _extract_username(medium_url: str) -> Optional[str]:
    if not medium_url:
        return None
    match = re.search(r"medium\.com/@([A-Za-z0-9_.-]+)", medium_url, re.IGNORECASE)
    if match:
        return match.group(1)
    match = re.search(r"(?:https?://)?([A-Za-z0-9_-]+)\.medium\.com", medium_url, re.IGNORECASE)
    if match:
        return match.group(1)
    return None


def get_medium_articles(candidate: Dict[str, Any], client: Any = None) -> Dict[str, Any]:
    """
    Fetch a candidate's recent Medium articles via their RSS feed. Falls back
    to a Tavily search (site-agnostic technical-writing search) when no
    Medium URL is known -- `client` is accepted but unused (kept for call-site
    compatibility with dispatch(), which passes it to every tool uniformly).

    Unlike the general web_search_tool, this fallback does not silently drop
    a same-surname-but-different-person result -- it's shown, but labeled by
    confidence (name_match_tier: exact vs. partial vs. none) so a recruiter
    can judge an unconfirmed match themselves instead of getting either a
    false NOT_FOUND or a confidently-wrong attribution.
    """
    medium_url = candidate.get("medium_url")
    username = _extract_username(medium_url) if medium_url else None

    if not username:
        name = candidate.get("name", "")
        if not name:
            return {"findings": "No Medium profile URL known for this candidate, and no name to search by.", "urls": []}

        text, urls = web_search.tavily_search(f"{name} technical articles blog Medium")
        combined = f"{text} " + " ".join(u.get("title", "") for u in urls)
        tier = web_search.name_match_tier(combined, name)

        if not urls or tier == "none":
            return {"findings": f"No Medium articles or technical writing found for {name}.", "urls": []}
        if tier == "partial":
            return {
                "findings": f'Possible match only (name similarity to "{name}", not confirmed as this specific candidate) -- verify manually: {text}',
                "urls": urls,
            }
        return {"findings": text, "urls": urls}

    try:
        resp = requests.get(f"https://medium.com/feed/@{username}", timeout=_TIMEOUT)
    except requests.exceptions.RequestException as e:
        return {"findings": f"Medium profile identified (@{username}), but the feed was unreachable: {e}.", "urls": [{"url": f"https://medium.com/@{username}", "title": username}]}

    if resp.status_code >= 400:
        return {"findings": f"Medium profile identified (@{username}), but its feed returned HTTP {resp.status_code}.", "urls": [{"url": f"https://medium.com/@{username}", "title": username}]}

    try:
        root = ET.fromstring(resp.content)
        items = root.findall("./channel/item")[:_MAX_ARTICLES]
    except ET.ParseError as e:
        return {"findings": f"Medium profile identified (@{username}), but the feed could not be parsed: {e}.", "urls": [{"url": f"https://medium.com/@{username}", "title": username}]}

    if not items:
        return {"findings": f"Medium profile @{username} has no published articles (or the feed is empty).", "urls": [{"url": f"https://medium.com/@{username}", "title": username}]}

    lines: List[str] = [f"Medium articles by @{username}:"]
    urls: List[Dict[str, str]] = [{"url": f"https://medium.com/@{username}", "title": username}]
    for item in items:
        title_el = item.find("title")
        link_el = item.find("link")
        title = title_el.text.strip() if title_el is not None and title_el.text else "Untitled"
        link = link_el.text.strip() if link_el is not None and link_el.text else ""
        lines.append(f"- {title}" + (f" [{link}]" if link else ""))
        if link:
            urls.append({"url": link, "title": title})

    return {"findings": "\n".join(lines), "urls": urls}
