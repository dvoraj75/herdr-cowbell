"""MkDocs hook: inline .github/CONTRIBUTING.md into contributing.md.

The file is written for GitHub, where `../SECURITY.md` resolves from `.github/`.
Relative link targets are rewritten to absolute GitHub URLs so the strict build
does not resolve them against docs/. Without the file, the include line is dropped.
"""

import posixpath
import re
from pathlib import Path

INCLUDE = '--8<-- ".github/CONTRIBUTING.md"'
SKIP = ("http://", "https://", "mailto:", "#", "/")
INLINE = re.compile(r"(\]\(\s*<?)([^)\s>]+)")
REFDEF = re.compile(r"^(\s{0,3}\[[^\]]+\]:\s*<?)([^\s>]+)")


def _absolute(target, base):
    if target.startswith(SKIP):
        return target
    path, tail = re.match(r"([^#?]*)(.*)", target).groups()
    norm = posixpath.normpath(posixpath.join(".github", path))
    if norm.startswith(".."):
        return target
    return f"{base}/blob/main/{norm}{tail}"


def _rewrite(text, base):
    out, fenced = [], False
    for line in text.splitlines():
        if line.lstrip().startswith(("```", "~~~")):
            fenced = not fenced
        elif not fenced:
            line = INLINE.sub(lambda m: m[1] + _absolute(m[2], base), line)
            line = REFDEF.sub(lambda m: m[1] + _absolute(m[2], base), line)
        out.append(line)
    return "\n".join(out)


def on_page_markdown(markdown, page, config, files, **kwargs):
    if page.file.src_uri != "contributing.md":
        return markdown
    source = Path(config.config_file_path).parent / ".github" / "CONTRIBUTING.md"
    body = ""
    if source.is_file():
        text = source.read_text(encoding="utf-8")
        # The page has its own "# Contributing" title; drop the file's H1.
        text = re.sub(r"\A\s*# [^\n]*\n", "", text)
        body = _rewrite(text, config.repo_url.rstrip("/"))
    return markdown.replace(INCLUDE, body)
