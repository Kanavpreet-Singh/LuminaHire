"""
Internal shared helper: best-effort HTTP GET + visible-text extraction from a
webpage. Used by gfg_tool, hackerrank_tool, codechef_tool, and portfolio_tool
-- all four are "fetch a profile/portfolio page and read whatever text is
there" with the identical degrade-gracefully contract, so this is factored
out once rather than duplicated four times. Not a tool itself (no
get_X_data name, not registered in the catalog).
"""

from typing import Any, Dict

import requests

TIMEOUT = 12
MAX_CHARS = 3000
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; LuminaHire-Research-Agent/1.0; +https://luminahire.tech)"
}


def fetch_and_summarize_webpage(url: str, max_chars: int = MAX_CHARS) -> Dict[str, Any]:
    """
    Best-effort HTTP GET + visible-text extraction from a webpage. No LLM
    involved; this is a raw fetch, not judgment. Many profile pages
    (notably LeetCode-style client-rendered SPAs) return a near-empty shell
    to a plain GET -- this degrades gracefully (still SUCCESS-shaped, citing
    the URL, with a note) rather than erroring, since the URL itself is
    still valid evidence even when rendered content can't be scraped
    server-side. Never raises.
    """
    if not url:
        return {"findings": "No URL provided.", "urls": []}

    try:
        from bs4 import BeautifulSoup
    except ImportError:
        return {"findings": f"Found link ({url}) but the page could not be scraped (missing bs4 dependency).", "urls": [{"url": url, "title": ""}]}

    try:
        resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
    except requests.exceptions.RequestException as e:
        return {"findings": f"Could not reach {url}: {e}", "urls": [{"url": url, "title": ""}]}

    if resp.status_code >= 400:
        return {"findings": f"{url} returned HTTP {resp.status_code}.", "urls": [{"url": url, "title": ""}]}

    try:
        soup = BeautifulSoup(resp.text, "html.parser")
        for tag in soup(["script", "style", "noscript", "svg"]):
            tag.decompose()
        title = (soup.title.string.strip() if soup.title and soup.title.string else "") or ""
        text = " ".join(soup.get_text(separator=" ", strip=True).split())
    except Exception as e:
        return {"findings": f"Fetched {url} but could not parse it: {e}", "urls": [{"url": url, "title": ""}]}

    if not text or len(text) < 40:
        return {
            "findings": (
                f"Profile/portfolio link identified at {url}. The page content is likely "
                "rendered client-side (JavaScript), so it could not be read directly, but "
                "the link itself is verifiable evidence."
            ),
            "urls": [{"url": url, "title": title}],
        }

    return {
        "findings": f"{title + ': ' if title else ''}{text[:max_chars]}",
        "urls": [{"url": url, "title": title}],
    }
