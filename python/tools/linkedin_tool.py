"""
LuminaHire — LinkedIn Tool
===========================
Best-effort, no-login scrape of a public LinkedIn profile URL. Technique:
plain GET with a "Guest"-style User-Agent, parse Open Graph meta tags
(og:title, og:description) and a follower-count regex -- the same approach
described in the GFG article "Scrape LinkedIn Profiles Without Login Using
Python". LinkedIn actively gates most unauthenticated traffic behind a login
wall, so this is genuinely best-effort: it often returns thin or empty
content, but sites populate OG tags server-side for link-preview/SEO
purposes, which sometimes survive even when the visible page doesn't.

Never raises. Always cites the URL as evidence regardless of scrape success,
same degrade-gracefully contract as every other tool in this package.
"""

import re
from typing import Any, Dict

import requests

_TIMEOUT = 10
# "Guest" User-Agent, matching the technique used to get past the immediate
# bot-block that a default requests User-Agent triggers.
_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
}


def get_linkedin_data(url: str) -> Dict[str, Any]:
    """Best-effort fetch of a public LinkedIn profile's OG metadata. Never raises."""
    if not url:
        return {"findings": "No LinkedIn URL provided.", "urls": []}

    try:
        from bs4 import BeautifulSoup
    except ImportError:
        return {"findings": f"LinkedIn profile identified ({url}) but could not be scraped (missing bs4 dependency).", "urls": [{"url": url, "title": ""}]}

    try:
        resp = requests.get(url, headers=_HEADERS, timeout=_TIMEOUT, allow_redirects=True)
    except requests.exceptions.RequestException as e:
        return {"findings": f"Could not reach LinkedIn profile {url}: {e}", "urls": [{"url": url, "title": ""}]}

    if resp.status_code >= 400:
        return {
            "findings": f"LinkedIn profile identified at {url}, but the page returned HTTP {resp.status_code} "
                        "(LinkedIn commonly blocks unauthenticated requests). The link itself is still verifiable evidence.",
            "urls": [{"url": url, "title": ""}],
        }

    try:
        soup = BeautifulSoup(resp.text, "html.parser")
        title = (soup.title.string.strip() if soup.title and soup.title.string else "") or ""

        og_description = ""
        og_tag = soup.find("meta", attrs={"property": "og:description"})
        if og_tag and og_tag.get("content"):
            og_description = og_tag["content"].strip()

        followers = ""
        follower_match = re.search(r"([\d,]+)\s+followers", og_description, re.IGNORECASE)
        if follower_match:
            followers = follower_match.group(1)
    except Exception as e:
        return {"findings": f"Fetched LinkedIn profile {url} but could not parse it: {e}", "urls": [{"url": url, "title": ""}]}

    if not title and not og_description:
        return {
            "findings": (
                f"LinkedIn profile identified at {url}. LinkedIn blocks most unauthenticated scraping, so no "
                "readable profile content could be extracted, but the link itself is verifiable evidence."
            ),
            "urls": [{"url": url, "title": ""}],
        }

    lines = [f"LinkedIn profile ({url}):"]
    if title:
        lines.append(f"- {title}")
    if og_description:
        lines.append(f"- {og_description}")
    if followers:
        lines.append(f"- Followers: {followers}")

    return {"findings": "\n".join(lines), "urls": [{"url": url, "title": title}]}
