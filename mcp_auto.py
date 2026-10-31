#!/usr/bin/env python3
"""mcp_auto — MCP tool-call auto workflow: retry, validate, fall back to Qwen, satisfy by code.

Route doctrine (AGENTS.md §3): gateway MCP is primary; on gateway failure, do NOT
bypass — the Qwen lane is a READ-ONLY judgment fallback, never a mutating call.
"""

import json
import socket
import time
import urllib.error
import urllib.request

GATEWAY = "http://127.0.0.1:25127/mcp"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36")


class McpResult:
    def __init__(self, ok, data, lane, attempts, error=None):
        self.ok, self.data, self.lane, self.attempts, self.error = ok, data, lane, attempts, error
    def __repr__(self):
        head = json.dumps(self.data)[:120] if self.data is not None else self.error
        return f"McpResult(ok={self.ok}, lane={self.lane}, attempts={self.attempts}, data={head})"


def call_tool(server_tool, args, timeout=60, retries=3, validate=None):
    """Call an MCP tool through the gateway with retry + validation.

    server_tool: "<server>:<tool>". validate(data) -> bool for content checks.
    Returns McpResult. Never retries a *validated* success.
    """
    name, tool = server_tool.split(":", 1)
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                          "params": {"name": tool, "arguments": args}}).encode()
    last = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(GATEWAY, data=payload,
                                         headers={"Content-Type": "application/json", "User-Agent": UA})
            raw = json.load(urllib.request.urlopen(req, timeout=timeout))
            if "error" in raw:
                last = RuntimeError(raw["error"].get("message", "jsonrpc error"))
            else:
                data = raw.get("result")
                if validate is None or validate(data):
                    return McpResult(True, data, "mcp", attempt)
                last = ValueError("output failed validation")
        except (urllib.error.URLError, urllib.error.HTTPError, socket.timeout, TimeoutError,
                json.JSONDecodeError, ConnectionError) as e:
            last = e
        time.sleep(min(2 * attempt, 5))
    return McpResult(False, None, "mcp", retries, error=str(last))


def auto(server_tool, args, fallback_prompt=None, validate=None, **kw):
    """Primary lane = MCP; on total failure + fallback_prompt given, judge via Qwen.

    The fallback is clearly labeled; a caller that needs MCP side effects must NOT
    pass a fallback_prompt (mutating ops fail loudly instead of silently morphing).
    """
    r = call_tool(server_tool, args, validate=validate, **kw)
    if r.ok:
        return r
    if fallback_prompt:
        from completions import chat  # sibling module
        try:
            text, usage = chat([{"role": "user", "content": fallback_prompt}])
            return McpResult(True, {"qwen_judgment": text}, "qwen-fallback", r.attempts)
        except Exception as e:
            return McpResult(False, None, "mcp->qwen", r.attempts,
                             error=f"mcp: {r.error}; qwen: {e}")
    return r


if __name__ == "__main__":
    import sys
    tool, arg = sys.argv[1], json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    print(auto(tool, arg))
