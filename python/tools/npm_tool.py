"""
LuminaHire — npm Packages Tool
================================
Checks if a candidate publishes open-source packages under a resume-linked
npm username, via npm's registry endpoint (registry.npmjs.org/-/user/...) --
stable, long-standing, no auth needed.
"""

import re
from typing import Any, Dict, List, Optional

import requests

_TIMEOUT = 10


def _extract_username(username_or_url: str) -> Optional[str]:
    if not username_or_url:
        return None
    match = re.search(r"npmjs\.com/~([A-Za-z0-9_-]+)", username_or_url, re.IGNORECASE)
    if match:
        return match.group(1)
    if re.match(r"^[A-Za-z0-9_-]+$", username_or_url):
        return username_or_url
    return None


def get_npm_packages(username_or_url: str) -> Dict[str, Any]:
    """Fetch a candidate's published npm packages via the npm registry."""
    username = _extract_username(username_or_url)
    if not username:
        return {"findings": "No valid npm username/URL provided.", "urls": []}

    profile_url = f"https://www.npmjs.com/~{username}"
    try:
        resp = requests.get(f"https://registry.npmjs.org/-/user/{username}/package", timeout=_TIMEOUT)
    except requests.exceptions.RequestException as e:
        return {"findings": f"npm profile identified ({profile_url}), but the registry was unreachable: {e}.", "urls": [{"url": profile_url, "title": username}]}

    if resp.status_code >= 400:
        return {"findings": f"No npm packages found for user '{username}' (HTTP {resp.status_code}).", "urls": [{"url": profile_url, "title": username}]}

    try:
        packages = resp.json()
    except ValueError:
        return {"findings": f"npm profile identified ({profile_url}), but the response could not be parsed.", "urls": [{"url": profile_url, "title": username}]}

    if not isinstance(packages, dict) or not packages:
        return {"findings": f"npm user '{username}' has no published packages.", "urls": [{"url": profile_url, "title": username}]}

    lines = [f"npm packages published by {username}:"]
    urls: List[Dict[str, str]] = [{"url": profile_url, "title": username}]
    for pkg_name in list(packages.keys())[:10]:
        pkg_url = f"https://www.npmjs.com/package/{pkg_name}"
        lines.append(f"- {pkg_name} [{pkg_url}]")
        urls.append({"url": pkg_url, "title": pkg_name})

    return {"findings": "\n".join(lines), "urls": urls}
