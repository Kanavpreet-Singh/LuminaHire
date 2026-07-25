"""
LuminaHire — GeeksforGeeks Tool
================================
Scrapes the candidate's GeeksforGeeks profile page directly
(geeksforgeeks.org/profile/{username}?tab=activity) rather than relying on an
unofficial third-party stats API. The profile page is a Next.js (App Router)
app -- the data isn't in the raw HTML, but the server-rendered React Server
Component payload is inlined in `<script>self.__next_f.push([...])</script>`
tags. Those chunks are reassembled into one text blob, and the `{"mentor":
...}` object (name, institute, score, problems solved, streaks, articles) is
pulled out of it by brace-matching -- simpler and more robust than modeling
the whole RSC wire format.

Falls back to a best-effort generic page scrape (same degrade-gracefully
contract as the rest of this package) whenever the username can't be parsed
from the URL, the request fails, or the expected payload isn't found (e.g.
the page layout changes upstream).

(An earlier version used the unofficial gfg-stats.tashif.codes API and,
before that, github.com/arnoob16/GeeksForGeeksAPI -- both were replaced after
proving unreliable.)
"""

import json
import re
from typing import Any, Dict, List, Optional
from urllib.parse import quote, unquote

import requests

from ._webpage import fetch_and_summarize_webpage

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
}
_TIMEOUT = 15

_USERNAME_RE = re.compile(r"geeksforgeeks\.org/(?:user|profile)/([^/?#]+)", re.IGNORECASE)
_RSC_CHUNK_RE = re.compile(r'self\.__next_f\.push\(\[\d+,(".*?")\]\)</script>', re.S)


def _extract_username(url: str) -> Optional[str]:
    match = _USERNAME_RE.search(url)
    return unquote(match.group(1)) if match else None


def _reassemble_rsc_text(html: str) -> str:
    """Next.js streams the RSC payload as escaped JSON string chunks; decode and concatenate them in order."""
    parts: List[str] = []
    for chunk in _RSC_CHUNK_RE.finditer(html):
        try:
            parts.append(json.loads(chunk.group(1)))
        except (json.JSONDecodeError, ValueError):
            continue
    return "".join(parts)


def _extract_balanced_json(text: str, marker: str) -> Optional[Dict[str, Any]]:
    """Find `marker` and brace-match forward to pull out one complete JSON object, string-aware."""
    start = text.find(marker)
    if start == -1:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            continue
        if c == '"':
            in_str = True
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start:i + 1])
                except (json.JSONDecodeError, ValueError):
                    return None
    return None


def _scrape_profile(username: str) -> Optional[Dict[str, Any]]:
    fetch_url = f"https://www.geeksforgeeks.org/profile/{quote(username, safe='')}?tab=activity"
    try:
        resp = requests.get(fetch_url, headers=_HEADERS, timeout=_TIMEOUT)
    except requests.exceptions.RequestException:
        return None
    if resp.status_code >= 400:
        return None
    rsc_text = _reassemble_rsc_text(resp.text)
    return _extract_balanced_json(rsc_text, '{"mentor":')


def get_gfg_data(url: str) -> Dict[str, Any]:
    """Fetch a candidate's GeeksforGeeks profile by scraping the profile page, falling back to a generic page scrape."""
    if not url:
        return {"findings": "No GeeksforGeeks URL provided.", "urls": []}

    username = _extract_username(url)
    if username:
        profile_url = f"https://www.geeksforgeeks.org/profile/{quote(username, safe='')}"
        data = _scrape_profile(username)
        if data:
            mentor = data.get("mentor") or {}
            stats = data.get("articleCount") or {}

            lines: List[str] = [f"GeeksforGeeks @{username} ({profile_url}):"]
            if mentor.get("name"):
                lines.append(f"- Name: {mentor.get('name')}")
            institution = stats.get("institute_name") or mentor.get("headline")
            if institution:
                lines.append(f"- Institution: {institution}")
            if stats.get("total_problems_solved") is not None:
                lines.append(f"- Total problems solved: {stats.get('total_problems_solved')}")
            if stats.get("score") is not None:
                lines.append(f"- Coding score: {stats.get('score')}")
            if stats.get("institute_rank") is not None:
                lines.append(f"- Institute rank: {stats.get('institute_rank')}")
            if stats.get("pod_solved_longest_streak") is not None:
                lines.append(f"- Longest solving streak: {stats.get('pod_solved_longest_streak')} days")
            if stats.get("total_articles_published"):
                lines.append(f"- Articles published: {stats.get('total_articles_published')}")
            return {
                "findings": "\n".join(lines),
                "urls": [{"url": profile_url, "title": mentor.get("name") or username}],
                "identity": {"name": mentor.get("name"), "handle": username},
            }

    # Username couldn't be parsed, the request failed, or the page layout
    # didn't match what we expect -- fall back to the generic text scrape.
    return fetch_and_summarize_webpage(url)
