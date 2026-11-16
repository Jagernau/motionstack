#!/usr/bin/env python3
"""Build gate: reject missing dependencies and JavaScript syntax errors before APK packaging."""
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
html = (ROOT / "index.html").read_text(encoding="utf-8")
script_files = re.findall(r'<script\s+src="([^"?]+)(?:\?[^\"]*)?"\s*></script>', html)
assert script_files, "No JavaScript entrypoint specified"
assert "studio.js" in script_files, "The Studio editor must be loaded"
for path in script_files:
    source = ROOT / path
    assert source.is_file(), f"Referenced script missing: {path}"
    subprocess.run(["node", "--check", str(source)], check=True)
for index, source in enumerate(re.findall(r'<script(?:\s[^>]*)?>(.*?)</script>', html, flags=re.S | re.I)):
    if not source.strip():
        continue
    script = ROOT / f".temp_check_{index}.js"
    try:
        script.write_text(source, encoding="utf-8")
        subprocess.run(["node", "--check", str(script)], check=True)
    finally:
        script.unlink(missing_ok=True)
for element_id in ("preview", "startRange", "endRange", "timeline", "filmstrip", "phaseStrip", "subjectCanvas", "resultCanvas", "export"):
    assert f'id="{element_id}"' in html, f"Required UI element missing: {element_id}"
for marker in ("function autoPickPhases()", "async function autoSegmentAll(", "function backgroundCanvas()", "function estimateShift(", "function actionRect()"):
    assert marker in (ROOT / "studio.js").read_text(encoding="utf-8"), f"Core algorithm missing: {marker}"
print("MotionStack Studio: source syntax and UI/algorithm structural checks passed")
