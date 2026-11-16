#!/usr/bin/env python3
"""Smoke-check every JavaScript source before an APK can be built."""
import re
import subprocess
import tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
html=(ROOT/"index.html").read_text(encoding="utf-8")
external=ROOT/"autosegment.js"
assert external.exists(), "autosegment.js is required for local and APK builds"
src=external.read_text(encoding="utf-8")
assert "function medianBackground()" in src, "Background helper missing"
assert "async function segmentSingle(" in src, "Segmentation helper missing"
assert "return {x,y,w,h,input,nx,ny};" in src, "Crop transformation must return all coordinates"
assert '<script src="autosegment.js"></script>' in html, "HTML must load the AI script"
subprocess.run(["node","--check",str(external)],check=True)
inline=re.findall(r"<script(?:\\s[^>]*)?>(.*?)</script>",html,flags=re.S|re.I)
assert any(x.strip() for x in inline), "No inline application JavaScript"
with tempfile.TemporaryDirectory() as directory:
    for i,text in enumerate(inline):
        if not text.strip():continue
        script=Path(directory)/f"index_inline_{i}.js"
        script.write_text(text,encoding="utf-8")
        subprocess.run(["node","--check",str(script)],check=True)
print("JavaScript source syntax and structural checks: OK")
