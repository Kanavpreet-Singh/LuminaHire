"""
LuminaHire — HackerRank Tool
=============================
No usable public API for HackerRank user profiles -- generic best-effort
page scrape, same contract as the rest of this package.
"""

from typing import Any, Dict

from ._webpage import fetch_and_summarize_webpage


def get_hackerrank_data(url: str) -> Dict[str, Any]:
    """Best-effort fetch of a candidate's HackerRank profile page."""
    if not url:
        return {"findings": "No HackerRank URL provided.", "urls": []}
    return fetch_and_summarize_webpage(url)
