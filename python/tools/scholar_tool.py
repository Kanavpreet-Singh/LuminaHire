"""
LuminaHire — Scholar Papers Tool (Semantic Scholar)
=====================================================
Google Scholar has no viable API and scraping it directly gets IP-blocked
and violates its ToS. Semantic Scholar (Allen Institute for AI) covers the
same intent -- finding a candidate's published papers -- legitimately: free,
no auth required for this volume, well-documented REST endpoints.
"""

from typing import Any, Dict, List

import requests

API_BASE = "https://api.semanticscholar.org/graph/v1"
_TIMEOUT = 12
_MAX_PAPERS = 5


def get_scholar_papers(candidate: Dict[str, Any]) -> Dict[str, Any]:
    """Find a candidate's published papers via the Semantic Scholar API, matched by name."""
    name = candidate.get("name", "")
    if not name:
        return {"findings": "No candidate name available to search for papers.", "urls": []}

    try:
        search_resp = requests.get(
            f"{API_BASE}/author/search",
            params={"query": name, "fields": "name,paperCount,url"},
            timeout=_TIMEOUT,
        )
        search_data = search_resp.json()
    except (requests.exceptions.RequestException, ValueError) as e:
        return {"findings": f"Could not search Semantic Scholar for '{name}': {e}.", "urls": []}

    authors = search_data.get("data") or []
    if not authors:
        return {"findings": f"No Semantic Scholar author profile found matching '{name}'.", "urls": []}

    author = authors[0]
    author_id = author.get("authorId")
    author_url = author.get("url", "")

    if not author_id or not author.get("paperCount"):
        return {"findings": f"A Semantic Scholar profile matching '{name}' was found but has no published papers on record.", "urls": [{"url": author_url, "title": name}] if author_url else []}

    try:
        papers_resp = requests.get(
            f"{API_BASE}/author/{author_id}/papers",
            params={"fields": "title,url,year,citationCount", "limit": _MAX_PAPERS},
            timeout=_TIMEOUT,
        )
        papers_data = papers_resp.json()
    except (requests.exceptions.RequestException, ValueError) as e:
        return {"findings": f"Found Semantic Scholar author '{name}' but could not fetch their papers: {e}.", "urls": [{"url": author_url, "title": name}] if author_url else []}

    papers = papers_data.get("data") or []
    if not papers:
        return {"findings": f"Semantic Scholar author '{name}' has no listed papers.", "urls": [{"url": author_url, "title": name}] if author_url else []}

    lines = [f"Published papers by {name} (Semantic Scholar):"]
    urls: List[Dict[str, str]] = [{"url": author_url, "title": name}] if author_url else []
    for paper in papers:
        title = paper.get("title", "Untitled")
        year = paper.get("year", "N/A")
        citations = paper.get("citationCount", 0)
        url = paper.get("url", "")
        lines.append(f"- {title} ({year}, {citations} citations)" + (f" [{url}]" if url else ""))
        if url:
            urls.append({"url": url, "title": title})

    return {"findings": "\n".join(lines), "urls": urls}
