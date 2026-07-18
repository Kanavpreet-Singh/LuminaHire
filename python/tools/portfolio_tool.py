"""
LuminaHire — Portfolio Website Tool
=====================================
Best-effort fetch + text extraction from a candidate's personal
portfolio/website link (extracted from their resume). Same shared scraper as
gfg_tool/hackerrank_tool/codechef_tool.
"""

from typing import Any, Dict

from ._webpage import fetch_and_summarize_webpage


def get_portfolio_website_data(url: str) -> Dict[str, Any]:
    """Best-effort fetch of a candidate's personal portfolio/website."""
    if not url:
        return {"findings": "No portfolio URL provided.", "urls": []}
    return fetch_and_summarize_webpage(url)
