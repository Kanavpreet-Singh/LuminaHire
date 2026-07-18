"""
LuminaHire — arXiv Tool
========================
Official arXiv API (export.arxiv.org/api) -- no auth needed, stable Atom XML
response, parsed with the stdlib (no new dependency).
"""

import xml.etree.ElementTree as ET
from typing import Any, Dict, List

import requests

API_BASE = "http://export.arxiv.org/api/query"
_TIMEOUT = 12
_MAX_PAPERS = 5
_ATOM_NS = {"atom": "http://www.w3.org/2005/Atom"}


def get_arxiv_papers(candidate: Dict[str, Any]) -> Dict[str, Any]:
    """Find a candidate's arXiv papers via the official API, matched by author name."""
    name = candidate.get("name", "")
    if not name:
        return {"findings": "No candidate name available to search for papers.", "urls": []}

    try:
        resp = requests.get(
            API_BASE,
            params={"search_query": f'au:"{name}"', "max_results": _MAX_PAPERS},
            timeout=_TIMEOUT,
        )
    except requests.exceptions.RequestException as e:
        return {"findings": f"Could not search arXiv for '{name}': {e}.", "urls": []}

    try:
        root = ET.fromstring(resp.content)
        entries = root.findall("atom:entry", _ATOM_NS)
    except ET.ParseError as e:
        return {"findings": f"arXiv search for '{name}' returned an unparsable response: {e}.", "urls": []}

    if not entries:
        return {"findings": f"No arXiv papers found for author '{name}'.", "urls": []}

    lines = [f"arXiv papers by {name}:"]
    urls: List[Dict[str, str]] = []
    for entry in entries:
        title_el = entry.find("atom:title", _ATOM_NS)
        link_el = entry.find("atom:id", _ATOM_NS)
        published_el = entry.find("atom:published", _ATOM_NS)
        title = " ".join((title_el.text or "").split()) if title_el is not None else "Untitled"
        link = (link_el.text or "").strip() if link_el is not None else ""
        year = (published_el.text or "")[:4] if published_el is not None else "N/A"
        lines.append(f"- {title} ({year})" + (f" [{link}]" if link else ""))
        if link:
            urls.append({"url": link, "title": title})

    return {"findings": "\n".join(lines), "urls": urls}
