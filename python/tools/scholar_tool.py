"""
LuminaHire — Scholar Papers Tool (Semantic Scholar)
=====================================================
Google Scholar has no viable API and scraping it directly gets IP-blocked
and violates its ToS. Semantic Scholar (Allen Institute for AI) covers the
same intent -- confirming a publication a candidate claims -- legitimately:
free, no auth required for this volume, well-documented REST endpoints.

VERIFY BY PAPER TITLE, NOT BY PERSON NAME
------------------------------------------
This tool used to search Semantic Scholar for the candidate's *name* and
report the first matching author's papers as theirs. That is unsound: author
search returns whoever ranks first for that string, so any candidate sharing
a name with a published academic would silently inherit a stranger's
publication record -- and the recruiter would have no way to tell.

The supported path now is verification of a specific claim: given a paper
title the candidate's own resume names, look that paper up and check whether
the candidate is actually among its authors. That answers the question a
recruiter actually has ("did they really write this?") and cannot attach the
wrong person's work to the candidate. Name-only lookup is still available but
is explicitly reported as UNCONFIRMED attribution, never as verified fact.
"""

from typing import Any, Dict, List, Optional

import requests

import verification

API_BASE = "https://api.semanticscholar.org/graph/v1"
_TIMEOUT = 12
_MAX_PAPERS = 5


def _authors_include(candidate_name: str, authors: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Return the identity-match record for the first author matching the candidate, else None."""
    for author in authors:
        result = verification.match_names(candidate_name, author.get("name"))
        if result["verdict"] in (verification.IDENTITY_MATCH, verification.IDENTITY_PARTIAL):
            return {"author_name": author.get("name"), **result}
    return None


def _verify_by_title(candidate_name: str, title: str) -> Dict[str, Any]:
    """Look up a specific claimed paper and check the candidate is among its authors."""
    try:
        resp = requests.get(
            f"{API_BASE}/paper/search",
            params={"query": title, "fields": "title,url,year,citationCount,authors", "limit": 5},
            timeout=_TIMEOUT,
        )
        data = resp.json()
    except (requests.exceptions.RequestException, ValueError) as e:
        return {"findings": f"Could not reach Semantic Scholar to verify the paper \"{title}\": {e}.", "urls": []}

    papers = data.get("data") or []
    if not papers:
        return {
            "findings": (
                f"No paper matching the claimed title \"{title}\" was found on Semantic Scholar. "
                "This does not disprove the claim -- Semantic Scholar's coverage is incomplete, especially "
                "for workshop papers, non-English venues, and very recent preprints."
            ),
            "urls": [],
        }

    paper = papers[0]
    authors = paper.get("authors") or []
    author_names = [a.get("name") for a in authors if a.get("name")]
    url = paper.get("url", "")
    match = _authors_include(candidate_name, authors)

    lines = [
        f"Claimed paper: \"{title}\"",
        f"- Closest match found: \"{paper.get('title')}\" ({paper.get('year', 'N/A')}, "
        f"{paper.get('citationCount', 0)} citations)",
        f"- Listed authors: {', '.join(author_names) or 'none listed'}",
    ]
    if match:
        lines.append(
            f"- AUTHORSHIP CONFIRMED: \"{match['author_name']}\" in the author list matches the candidate."
        )
    else:
        lines.append(
            f"- AUTHORSHIP NOT CONFIRMED: no author on this paper matches \"{candidate_name}\". "
            "Either the candidate is not an author, the title is approximate, or their name is "
            "recorded differently in this index."
        )

    return {
        "findings": "\n".join(lines),
        "urls": [{"url": url, "title": paper.get("title") or title}] if url else [],
        "authorship_confirmed": bool(match),
    }


def _lookup_by_name(candidate_name: str) -> Dict[str, Any]:
    """Best-effort name lookup -- always reported as UNCONFIRMED attribution."""
    try:
        resp = requests.get(
            f"{API_BASE}/author/search",
            params={"query": candidate_name, "fields": "name,paperCount,url,affiliations"},
            timeout=_TIMEOUT,
        )
        data = resp.json()
    except (requests.exceptions.RequestException, ValueError) as e:
        return {"findings": f"Could not search Semantic Scholar for '{candidate_name}': {e}.", "urls": []}

    authors = data.get("data") or []
    if not authors:
        return {"findings": f"No Semantic Scholar author profile matches '{candidate_name}'.", "urls": []}

    if len(authors) > 1:
        return {
            "findings": (
                f"Semantic Scholar lists {len(authors)} different authors named '{candidate_name}'. "
                "Which (if any) is this candidate cannot be determined from the name alone, so no "
                "publication record is attributed to them. Ask the candidate for a Scholar/ORCID link "
                "or a specific paper title to verify against."
            ),
            "urls": [],
        }

    author = authors[0]
    author_url = author.get("url", "")
    paper_count = author.get("paperCount") or 0
    affiliations = ", ".join(author.get("affiliations") or []) or "none listed"
    return {
        "findings": (
            f"A single Semantic Scholar author profile matches '{candidate_name}' "
            f"({paper_count} paper(s), affiliation: {affiliations}). ATTRIBUTION UNCONFIRMED: this is a "
            "name match only -- nothing links this profile to the candidate beyond a shared name. Treat it "
            "as a lead to confirm with the candidate, not as verified evidence."
        ),
        "urls": [{"url": author_url, "title": candidate_name}] if author_url else [],
    }


def get_scholar_papers(candidate: Dict[str, Any], title: Optional[str] = None) -> Dict[str, Any]:
    """Verify a specific claimed publication by title (preferred), or do a clearly-labelled unconfirmed name lookup."""
    name = candidate.get("name", "")
    if not name:
        return {"findings": "No candidate name available to check publications against.", "urls": []}
    if title and title.strip():
        return _verify_by_title(name, title.strip())
    return _lookup_by_name(name)
