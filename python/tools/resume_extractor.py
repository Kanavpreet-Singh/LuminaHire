"""
LuminaHire — Resume URL Extraction
===================================
Deterministic, no-LLM scan of resume text for profile/portfolio URLs the
candidate mentioned but never filled into their site profile (e.g. "GitHub:
github.com/jdoe" in a resume header/footer). The caller (main.py's resume
processing) also appends any true PDF hyperlink targets into resume_text
before this runs, since a resume often shows link text like "GitHub" with the
real URL only present as a hyperlink annotation, not as visible text.
"""

import re
from typing import Dict, Optional

PROFILE_URL_KEYS = (
    "github_url", "linkedin_url", "leetcode_url", "gfg_url",
    "codeforces_url", "hackerrank_url", "codechef_url",
    "medium_url", "devto_url", "stackoverflow_url", "npm_username",
    "scholar_url", "portfolio_url",
)

# Domains that never count as a "portfolio" link even though they're not one
# of the platforms we already extract explicitly above.
_PORTFOLIO_EXCLUDE_DOMAINS = (
    "github.com", "linkedin.com", "leetcode.com", "geeksforgeeks.org",
    "codeforces.com", "hackerrank.com", "codechef.com", "medium.com",
    "dev.to", "stackoverflow.com", "npmjs.com", "scholar.google.com",
    "google.com", "gmail.com", "mailto:", "tel:",
    "overleaf.com", "canva.com", "notion.so", "docs.google.com",
    "drive.google.com", "twitter.com", "x.com", "facebook.com",
    "instagram.com", "youtube.com",
)


def extract_profile_urls_from_resume(resume_text: Optional[str]) -> Dict[str, Optional[str]]:
    """
    Best-effort, deterministic scan of raw resume text for profile/portfolio
    URLs. Returns a dict with all of PROFILE_URL_KEYS, each str|None.
    """
    result: Dict[str, Optional[str]] = {k: None for k in PROFILE_URL_KEYS}
    if not resume_text:
        return result

    gh_match = re.search(
        r"(?:https?://)?(?:www\.)?github\.com/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)",
        resume_text, re.IGNORECASE,
    )
    if gh_match and gh_match.group(1).lower() not in {"orgs", "settings", "about", "features", "pricing"}:
        result["github_url"] = f"https://github.com/{gh_match.group(1)}"

    li_match = re.search(
        r"(?:https?://)?(?:[a-z]{2,3}\.)?linkedin\.com/(in|pub)/([A-Za-z0-9\-_%]+)",
        resume_text, re.IGNORECASE,
    )
    if li_match:
        result["linkedin_url"] = f"https://www.linkedin.com/{li_match.group(1).lower()}/{li_match.group(2)}"

    lc_match = re.search(
        r"(?:https?://)?(?:www\.)?leetcode\.com/(?:u/)?([A-Za-z0-9_-]+)",
        resume_text, re.IGNORECASE,
    )
    if lc_match:
        result["leetcode_url"] = f"https://leetcode.com/u/{lc_match.group(1)}"

    gfg_match = re.search(
        r"(?:https?://)?(?:auth\.)?(?:www\.)?geeksforgeeks\.org/user/([A-Za-z0-9_-]+)",
        resume_text, re.IGNORECASE,
    )
    if gfg_match:
        result["gfg_url"] = f"https://www.geeksforgeeks.org/user/{gfg_match.group(1)}"

    cf_match = re.search(
        r"(?:https?://)?(?:www\.)?codeforces\.com/profile/([A-Za-z0-9_-]+)",
        resume_text, re.IGNORECASE,
    )
    if cf_match:
        result["codeforces_url"] = f"https://codeforces.com/profile/{cf_match.group(1)}"

    hr_match = re.search(
        r"(?:https?://)?(?:www\.)?hackerrank\.com/(?:profile/)?([A-Za-z0-9_-]+)",
        resume_text, re.IGNORECASE,
    )
    if hr_match and hr_match.group(1).lower() not in {"contests", "domains", "jobs"}:
        result["hackerrank_url"] = f"https://www.hackerrank.com/profile/{hr_match.group(1)}"

    cc_match = re.search(
        r"(?:https?://)?(?:www\.)?codechef\.com/users/([A-Za-z0-9_-]+)",
        resume_text, re.IGNORECASE,
    )
    if cc_match:
        result["codechef_url"] = f"https://www.codechef.com/users/{cc_match.group(1)}"

    # Medium: either medium.com/@username or username.medium.com
    med_match = re.search(
        r"(?:https?://)?(?:www\.)?medium\.com/@([A-Za-z0-9_.-]+)",
        resume_text, re.IGNORECASE,
    )
    if not med_match:
        med_match = re.search(
            r"(?:https?://)?([A-Za-z0-9_-]+)\.medium\.com",
            resume_text, re.IGNORECASE,
        )
    if med_match:
        result["medium_url"] = f"https://medium.com/@{med_match.group(1)}"

    devto_match = re.search(
        r"(?:https?://)?(?:www\.)?dev\.to/([A-Za-z0-9_-]+)",
        resume_text, re.IGNORECASE,
    )
    if devto_match:
        result["devto_url"] = f"https://dev.to/{devto_match.group(1)}"

    so_match = re.search(
        r"(?:https?://)?(?:www\.)?stackoverflow\.com/users/(\d+)(?:/([A-Za-z0-9_-]+))?",
        resume_text, re.IGNORECASE,
    )
    if so_match:
        name_part = f"/{so_match.group(2)}" if so_match.group(2) else ""
        result["stackoverflow_url"] = f"https://stackoverflow.com/users/{so_match.group(1)}{name_part}"

    npm_match = re.search(
        r"(?:https?://)?(?:www\.)?npmjs\.com/~([A-Za-z0-9_-]+)",
        resume_text, re.IGNORECASE,
    )
    if npm_match:
        result["npm_username"] = npm_match.group(1)

    scholar_match = re.search(
        r"(?:https?://)?(?:www\.)?scholar\.google\.com/citations\?[^\s,)\]<>\"']*user=([A-Za-z0-9_-]+)",
        resume_text, re.IGNORECASE,
    )
    if scholar_match:
        result["scholar_url"] = f"https://scholar.google.com/citations?user={scholar_match.group(1)}"

    # Portfolio: the first http(s) URL in the text that isn't one of the
    # platforms above and isn't common resume-tooling/social noise.
    for raw_url in re.findall(r"https?://[^\s,)\]<>\"']+", resume_text, re.IGNORECASE):
        lowered = raw_url.lower()
        if any(domain in lowered for domain in _PORTFOLIO_EXCLUDE_DOMAINS):
            continue
        result["portfolio_url"] = raw_url.rstrip(".,;")
        break

    return result
