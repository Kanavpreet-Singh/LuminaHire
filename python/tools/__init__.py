"""
LuminaHire — Research Tools package.

Re-exports every public symbol from every submodule so existing call sites
(`import tools; tools.xyz(...)`) keep working unchanged after the flat
tools.py was split into this package. New code should prefer importing the
specific submodule (e.g. `from tools import catalog`) or the submodules
directly, but this top-level re-export is not deprecated -- just here for
convenience and backward compatibility.
"""

from .resume_extractor import extract_profile_urls_from_resume, PROFILE_URL_KEYS

from .github_tool import (
    extract_github_username,
    fetch_github_bundle,
    summarize_github_bundle,
    github_repo_urls,
    get_github_data,
    get_github_topic_data,
    github_topic_search_tool,
    github_profile_tool,
)

from .linkedin_tool import get_linkedin_data
from .leetcode_tool import get_leetcode_data
from .gfg_tool import get_gfg_data
from .codeforces_tool import get_codeforces_data
from .hackerrank_tool import get_hackerrank_data
from .codechef_tool import get_codechef_data
from .medium_tool import get_medium_articles
from .devto_tool import get_devto_articles
from .stackoverflow_tool import get_stackoverflow_data
from .scholar_tool import get_scholar_papers
from .arxiv_tool import get_arxiv_papers
from .npm_tool import get_npm_packages
from .portfolio_tool import get_portfolio_website_data
from ._webpage import fetch_and_summarize_webpage

from .web_search import (
    grounded_search,
    tavily_search,
    web_search_tool,
    QuotaExceededError,
    is_quota_or_overload_error,
)

from . import catalog

__all__ = [
    "extract_profile_urls_from_resume", "PROFILE_URL_KEYS",
    "extract_github_username", "fetch_github_bundle", "summarize_github_bundle",
    "github_repo_urls", "get_github_data", "get_github_topic_data",
    "github_topic_search_tool", "github_profile_tool",
    "get_linkedin_data", "get_leetcode_data", "get_gfg_data", "get_codeforces_data",
    "get_hackerrank_data", "get_codechef_data", "get_medium_articles",
    "get_devto_articles", "get_stackoverflow_data", "get_scholar_papers",
    "get_arxiv_papers", "get_npm_packages", "get_portfolio_website_data",
    "fetch_and_summarize_webpage",
    "grounded_search", "tavily_search", "web_search_tool",
    "QuotaExceededError", "is_quota_or_overload_error",
    "catalog",
]
