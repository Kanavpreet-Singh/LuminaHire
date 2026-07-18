"""
LuminaHire — CodeChef Tool
===========================
No usable public API exists for CodeChef user profiles (the one third-party
option found, deepaksuthar40128/Codechef-API, has its hosted deployment
disabled as of this writing -- confirmed via a live test, "Payment required /
DEPLOYMENT_DISABLED"). CodeChef's profile page, however, server-renders its
core rating widget (rating, stars, division, highest rating, global/country
rank) even though the rest of the page is mostly JS-rendered chrome -- the
previous generic whole-page-text scrape was drowning that real signal in
unrelated course-catalog/navigation boilerplate. This targets that specific
widget instead, falling back to the generic scrape if CodeChef's markup
changes and the targeted selectors stop matching.
"""

from typing import Any, Dict

import requests

from ._webpage import fetch_and_summarize_webpage, HEADERS, TIMEOUT


def get_codechef_data(url: str) -> Dict[str, Any]:
    """Fetch a candidate's CodeChef profile: targeted rating-widget scrape, falling back to a generic page scrape."""
    if not url:
        return {"findings": "No CodeChef URL provided.", "urls": []}

    try:
        from bs4 import BeautifulSoup
    except ImportError:
        return fetch_and_summarize_webpage(url)

    try:
        resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT, allow_redirects=True)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
    except Exception:
        return fetch_and_summarize_webpage(url)

    rating_div = soup.find("div", class_="rating-number")
    if not rating_div:
        # Markup doesn't match what we expect (page changed, or a private/
        # nonexistent profile) -- degrade to the generic scrape rather than
        # returning nothing.
        return fetch_and_summarize_webpage(url)

    rating = rating_div.get_text(strip=True)
    header = rating_div.parent

    lines = [f"CodeChef profile ({url}):"]
    if rating and rating.upper() != "NA":
        lines.append(f"- Rating: {rating}")

    stars_span = header.find("span", style=True) if header else None
    if stars_span:
        star_count = len((header.find("div", class_="rating-star") or header).find_all("span"))
        if star_count:
            lines.append(f"- Stars: {star_count}")

    division_div = header.find_all("div", recursive=False)[1] if header and len(header.find_all("div", recursive=False)) > 1 else None
    if division_div and division_div.get_text(strip=True):
        lines.append(f"- Division: {division_div.get_text(strip=True)}")

    highest = header.find("small") if header else None
    if highest and highest.get_text(strip=True):
        lines.append(f"- {highest.get_text(strip=True)}")

    ranks_div = soup.find("div", class_="rating-ranks")
    if ranks_div:
        rank_text = ranks_div.get_text(" ", strip=True)
        if rank_text and "inactive" not in rank_text.lower():
            lines.append(f"- {rank_text}")

    if len(lines) == 1:
        # Found the rating container but nothing usable inside it.
        return fetch_and_summarize_webpage(url)

    title_el = soup.title
    title = title_el.string.strip() if title_el and title_el.string else ""
    return {"findings": "\n".join(lines), "urls": [{"url": url, "title": title}]}
