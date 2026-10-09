#!/usr/bin/env python3
"""Generate GitHub Pages Jekyll source from the canonical docs/wiki files."""
import argparse
import html
import re
from pathlib import Path
from xml.etree.ElementTree import Element, SubElement, ElementTree

ROOT = Path(__file__).resolve().parents[2]
WIKI = ROOT / "docs/wiki"
BASE = "https://moretea-labs.github.io/forge"
LINK = re.compile(r"(?<!!)\[([^\]]+)\]\(([^)]+)\)")
DESCRIPTION = "Forge: local-first ChatGPT MCP for secure computer use, browser automation, coding, and developer workflows."

LAYOUT = """<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="{{ page.description | escape }}">
<meta name="robots" content="index,follow">
<meta property="og:type" content="website">
<meta property="og:title" content="{{ page.title | escape }}">
<meta property="og:description" content="{{ page.description | escape }}">
<meta property="og:url" content="{{ page.url | absolute_url }}">
<link rel="canonical" href="{{ page.url | absolute_url }}">
<title>{{ page.title | escape }} | Forge</title>
<style>
:root{font:16px/1.65 system-ui,-apple-system,sans-serif;color:#182230;background:#fafafa}
body{margin:0}header{background:#101828;padding:1rem 2rem}header a{color:white;font-weight:bold;text-decoration:none}
.wrap{max-width:72rem;margin:auto;display:grid;grid-template-columns:14rem minmax(0,1fr);gap:2.5rem;padding:2rem}
nav{display:flex;flex-direction:column;gap:.5rem}nav a{color:#175cd3;text-decoration:none}
main{min-width:0;overflow-wrap:anywhere}a{color:#175cd3}h1,h2,h3{line-height:1.3}
pre{overflow-x:auto;background:#eaecf0;border-radius:.5rem;padding:1rem}
:not(pre)>code{background:#eaecf0;padding:.1em .25em;border-radius:.2rem}
table{display:block;overflow-x:auto;border-collapse:collapse}th,td{border:1px solid #d0d5dd;padding:.5rem;text-align:left}
footer{border-top:1px solid #d0d5dd;padding:1rem;text-align:center}
@media(max-width:760px){.wrap{display:block}nav{padding-bottom:1.5rem;border-bottom:1px solid #ddd}}
</style></head><body>
<header><a href="/forge/">Forge — ChatGPT MCP documentation</a></header>
<div class="wrap"><nav aria-label="Documentation">NAV_LINKS</nav><main>{{ content }}</main></div>
<footer><a href="https://github.com/moretea-labs/forge">GitHub</a> ·
<a href="https://www.npmjs.com/package/@moretea-labs/forge">npm</a> ·
<a href="https://github.com/moretea-labs/forge/wiki">Wiki</a></footer></body></html>"""


def rewrite(content, pages):
    def replace(match):
        title, url = match.groups()
        target, sep, fragment = url.partition("#")
        if target in pages:
            link = "./" if target == "Home" else target + ".html"
            return "[" + title + "](" + link + (sep + fragment if sep else "") + ")"
        return match.group(0)
    return LINK.sub(replace, content)


def build(dest):
    pages = {p.stem: p for p in WIKI.glob("*.md") if not p.name.startswith("_")}
    assert "Home" in pages and "Computer-and-Plugins" in pages
    assert all(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", slug) for slug in pages)
    sidebar = (WIKI / "_Sidebar.md").read_text(encoding="utf-8")
    nav = [(text, slug) for text, slug in LINK.findall(sidebar) if slug in pages]
    assert set(pages) == {slug for _, slug in nav}, "Wiki sidebar must list every public page"
    assert len(nav) == len(pages), "Wiki sidebar has duplicate entries"
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "_layouts").mkdir(exist_ok=True)
    links = "\n".join('<a href="/forge/' + ("" if slug == "Home" else slug + ".html")
                      + '">' + html.escape(name) + "</a>" for name, slug in nav)
    (dest / "_layouts/default.html").write_text(
        LAYOUT.replace("NAV_LINKS", links), encoding="utf-8")
    (dest / "_config.yml").write_text(
        'title: "Forge documentation"\nurl: "https://moretea-labs.github.io"\n'
        'baseurl: "/forge"\nmarkdown: kramdown\n', encoding="utf-8")
    urls = []
    for slug, path in sorted(pages.items()):
        source = path.read_text(encoding="utf-8")
        assert "moretea-labs/matea" not in source.lower(), path
        title = source.splitlines()[0].removeprefix("# ").replace('"', "'")
        permalink = "/" if slug == "Home" else "/" + slug + ".html"
        fm = ('---\nlayout: default\ntitle: "' + title
              + '"\ndescription: "' + DESCRIPTION
              + '"\npermalink: ' + permalink + '\n---\n\n')
        (dest / (("index" if slug == "Home" else slug) + ".md")).write_text(
            fm + rewrite(source, pages), encoding="utf-8")
        urls.append(BASE + permalink)
    (dest / "robots.txt").write_text(
        "User-agent: *\nAllow: /\nSitemap: " + BASE + "/sitemap.xml\n",
        encoding="utf-8")
    xml = Element("urlset", xmlns="http://www.sitemaps.org/schemas/sitemap/0.9")
    for url in urls:
        SubElement(SubElement(xml, "url"), "loc").text = url
    ElementTree(xml).write(str(dest / "sitemap.xml"),
                           encoding="utf-8", xml_declaration=True)
    print("Forge Pages: " + str(len(pages)) + " pages, navigation and sitemap verified")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    build(parser.parse_args().output)
