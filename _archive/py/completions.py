#!/usr/bin/env python3
"""agentic-completions — freeinference/Qwen client with proper prompts + code-run-first satisfaction gate.

Doctrine (2026-10-31):
- LLMs judge; CODE proves. A completion is never "satisfied" by model assertion alone.
- Cloudflare UA wall: always send a desktop browser UA (anomaly #14).
- Qwen3.6-35b ignores reasoning_effort (anomaly #2); max_tokens >= 2500 (anomaly #1).
- FreeInference is de facto 1-concurrent: serialize probes (observer effect, anomaly #4).
"""

import base64
import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.request

BASE = "https://freeinference.org/v1"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36")
DEFAULT_MODEL = "qwen3.6-35b"
MAX_TOKENS = 4000  # reasoning shares the budget; floor 2500


def get_key():
    env = os.environ.get("FREEINFERENCE_API_KEY")
    if env:
        return env.strip()
    r = subprocess.run(["secretsmith", "get", "--label", "FREEINFERENCE_API_KEY"],
                       capture_output=True, text=True, timeout=30)
    m = re.search(r"secret: (\S+)", r.stdout)
    if not m:
        raise RuntimeError("no FREEINFERENCE_API_KEY in env or keyring")
    return m.group(1)


def chat(messages, model=DEFAULT_MODEL, max_tokens=MAX_TOKENS, temperature=0.2,
         retries=3, image_path=None):
    """One completion. Retries on 429/5xx with backoff. image_path -> data-url for VL lanes."""
    key = get_key()
    content = None
    if image_path:
        b64 = base64.b64encode(open(image_path, "rb").read()).decode()
        content = [{"type": "image_url",
                    "image_url": {"url": f"data:image/png;base64,{b64}"}},
                   {"type": "text", "text": messages[-1]["content"]}]
        messages = messages[:-1] + [{"role": messages[-1]["role"], "content": content}]
    body = json.dumps({"model": model, "messages": messages,
                       "max_tokens": max_tokens, "temperature": temperature}).encode()
    last = None
    for attempt in range(retries):
        req = urllib.request.Request(
            f"{BASE}/chat/completions", data=body,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json",
                     "User-Agent": UA})
        try:
            resp = json.load(urllib.request.urlopen(req, timeout=120))
            choice = resp["choices"][0]["message"]["content"] or ""
            usage = resp.get("usage", {})
            if not choice.strip():
                last = RuntimeError("empty completion")
            else:
                return choice.strip(), usage
        except urllib.error.HTTPError as e:
            last = e
            if e.code == 429:
                time.sleep(2 * (attempt + 1))  # observer effect: serialize, back off
                continue
            if e.code >= 500:
                time.sleep(1.5)
                continue
            raise
    raise last


def structured(messages, model=DEFAULT_MODEL, retries=2):
    """Ask for STRICT JSON; on parse failure, one repair round-trip before giving up."""
    sysmsg = {"role": "system",
              "content": "You are a terse reviewer. Answer ONLY with a JSON object. No prose, no markdown fences."}
    text, usage = chat([sysmsg] + list(messages), model=model)
    try:
        return json.loads(text), usage
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.S)
        if m:
            try:
                return json.loads(m.group(0)), usage
            except json.JSONDecodeError:
                pass
        if retries <= 0:
            raise ValueError(f"model would not produce JSON: {text[:200]}")
        repair, usage2 = chat([
            sysmsg,
            {"role": "user", "content": f"{messages[-1]['content']}\n\nYour previous answer was not valid JSON: {text[:400]}\nReturn ONLY valid JSON."}
        ], model=model)
        return json.loads(repair), usage2


def satisfy(checks, judgment_prompt, model=DEFAULT_MODEL):
    """CODE RUNS FIRST. checks: list of (name, callable -> (bool, evidence)).

    All code checks must pass before the model is even consulted; the model's
    verdict can only flag issues, never declare satisfaction on its own.
    Returns {"satisfied": bool, "code_checks": [...], "judgment": str|None}.
    """
    results = []
    for name, fn in checks:
        ok, evidence = fn()
        results.append({"check": name, "ok": bool(ok), "evidence": str(evidence)[:300]})
        if not ok:
            return {"satisfied": False, "code_checks": results, "judgment": None}
    try:
        verdict, _ = chat([
            {"role": "system", "content":
                "You are a skeptical reviewer. Code checks already PASSED. "
                "You may flag concerns, but you cannot declare failure the checks contradict. "
                "End with EXACTLY one line: VERDICT: PASS or VERDICT: CONCERNS."},
            {"role": "user", "content": judgment_prompt},
        ], model=model)
    except Exception as e:
        return {"satisfied": True, "code_checks": results, "advisory": None,
                "judgment": f"(judgment lane unavailable, code-proved only: {e})"}
    # Code decides satisfaction; the model is advisory. A malformed verdict
    # (no VERDICT line) is a model-quirk note, never a satisfaction flip.
    concerns = "VERDICT: CONCERNS" in verdict
    advisory = concerns or "VERDICT:" not in verdict
    return {"satisfied": True, "code_checks": results,
            "advisory": "model flagged concerns" if concerns
                        else "model verdict malformed" if advisory else None,
            "judgment": verdict}
