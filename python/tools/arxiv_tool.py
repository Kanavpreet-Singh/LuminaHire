"""
LuminaHire — arXiv Tool
========================
Official arXiv API (export.arxiv.org/api) -- no auth needed, stable Atom XML
response, parsed with the stdlib (no new dependency).

VERIFY BY PAPER TITLE, NOT BY AUTHOR NAME
------------------------------------------
Same correction as scholar_tool: an `au:"Some Name"` query returns every
paper by anyone with that name, so reporting those results as the
candidate's work silently attributes strangers' publications to them. The
supported path is confirming a specific paper the resume names, checking the
candidate against the real author list. A bare author-name lookup is still
possible but is reported as UNCONFIRMED attribution, never as verified fact.
"""

import xml.etree.ElementTree as ET
from typing import Any, Dict, List, Optional

import requests

import verification

API_BASE = "http://export.arxiv.org/api/query"
_TIMEOUT = 12
_MAX_PAPERS = 5
_ATOM_NS = {"atom": "http://www.w3.org/2005/Atom"}


def _parse_entries(content: bytes) -> List[Dict[str, Any]]:
    root = ET.fromstring(content)
    entries: List[Dict[str, Any]] = []
    for entry in root.findall("atom:entry", _ATOM_NS):
        title_el = entry.find("atom:title", _ATOM_NS)
        link_el = entry.find("atom:id", _ATOM_NS)
        published_el = entry.find("atom:published", _ATOM_NS)
        authors = [
            " ".join((a.findtext("atom:name", default="", namespaces=_ATOM_NS) or "").split())
            for a in entry.findall("atom:author", _ATOM_NS)
        ]
        entries.append({
            "title": " ".join((title_el.text or "").split()) if title_el is not None else "Untitled",
            "url": (link_el.text or "").strip() if link_el is not None else "",
            "year": (published_el.text or "")[:4] if published_el is not None else "N/A",
            "authors": [a for a in authors if a],
        })
    return entries


def _query(params: Dict[str, Any], describe: str) -> Any:
    try:
        resp = requests.get(API_BASE, params=params, timeout=_TIMEOUT)
    except requests.exceptions.RequestException as e:
        return {"error": f"Could not reach arXiv to check {describe}: {e}."}
    try:
        return _parse_entries(resp.content)
    except ET.ParseError as e:
        return {"error": f"arXiv returned an unparsable response while checking {describe}: {e}."}


def _verify_by_title(candidate_name: str, title: str) -> Dict[str, Any]:
    entries = _query({"search_query": f'ti:"{title}"', "max_results": 3}, f'the paper "{title}"')
    if isinstance(entries, dict):
        return {"findings": entries["error"], "urls": []}
    if not entries:
        return {
            "findings": (
                f"No arXiv paper matching the claimed title \"{title}\" was found. arXiv only covers "
                "preprints, so a paper published solely in a journal or conference proceedings will "
                "legitimately not appear here -- this does not disprove the claim."
            ),
            "urls": [],
        }

    paper = entries[0]
    match = next(
        (a for a in paper["authors"]
         if verification.match_names(candidate_name, a)["verdict"]
         in (verification.IDENTITY_MATCH, verification.IDENTITY_PARTIAL)),
        None,
    )
    lines = [
        f"Claimed paper: \"{title}\"",
        f"- Closest arXiv match: \"{paper['title']}\" ({paper['year']})",
        f"- Listed authors: {', '.join(paper['authors']) or 'none listed'}",
        (f"- AUTHORSHIP CONFIRMED: \"{match}\" in the author list matches the candidate."
         if match else
         f"- AUTHORSHIP NOT CONFIRMED: no author on this paper matches \"{candidate_name}\"."),
    ]
    return {
        "findings": "\n".join(lines),
        "urls": [{"url": paper["url"], "title": paper["title"]}] if paper["url"] else [],
        "authorship_confirmed": bool(match),
    }


def _lookup_by_name(candidate_name: str) -> Dict[str, Any]:
    entries = _query({"search_query": f'au:"{candidate_name}"', "max_results": _MAX_PAPERS},
                     f"papers by {candidate_name}")
    if isinstance(entries, dict):
        return {"findings": entries["error"], "urls": []}
    if not entries:
        return {"findings": f"No arXiv papers list an author named '{candidate_name}'.", "urls": []}

    lines = [
        f"arXiv papers listing an author named '{candidate_name}' -- ATTRIBUTION UNCONFIRMED. "
        "arXiv author search matches on name only, so these may belong to a different person with the "
        "same name. Confirm with the candidate before treating any of this as their work:",
    ]
    urls: List[Dict[str, str]] = []
    for paper in entries:
        lines.append(f"- {paper['title']} ({paper['year']}; authors: {', '.join(paper['authors']) or 'N/A'})")
        if paper["url"]:
            urls.append({"url": paper["url"], "title": paper["title"]})
    return {"findings": "\n".join(lines), "urls": urls}


def get_arxiv_papers(candidate: Dict[str, Any], title: Optional[str] = None) -> Dict[str, Any]:
    """Verify a specific claimed preprint by title (preferred), or do a clearly-labelled unconfirmed author-name lookup."""
    name = candidate.get("name", "")
    if not name:
        return {"findings": "No candidate name available to check papers against.", "urls": []}
    if title and title.strip():
        return _verify_by_title(name, title.strip())
    return _lookup_by_name(name)
