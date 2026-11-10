"""Pin the REAL contracts (audit 2026-10-31, verified against live lanes)."""
import base64
import importlib
import json
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(__file__))
completions = importlib.import_module("completions")
mcp_auto = importlib.import_module("mcp_auto")


class TestSatisfyGate(unittest.TestCase):
    def test_failed_code_check_blocks_model_consult(self):
        called = []
        with mock.patch.object(completions, "chat", side_effect=lambda *a, **k: called.append(1) or ("VERDICT: PASS", {})):
            res = completions.satisfy([("bad", lambda: (False, "nope"))], "p")
        self.assertFalse(res["satisfied"])
        self.assertIsNone(res["judgment"])
        self.assertEqual(called, [])  # model never consulted

    def test_passing_code_check_is_satisfaction_even_with_model_concerns(self):
        with mock.patch.object(completions, "chat", return_value=("VERDICT: CONCERNS whatever", {})):
            res = completions.satisfy([("ok", lambda: (True, "ev"))], "p")
        self.assertTrue(res["satisfied"])
        self.assertEqual(res["advisory"], "model flagged concerns")

    def test_malformed_verdict_is_advisory_note_not_failure(self):
        with mock.patch.object(completions, "chat", return_value=("looks fine to me", {})):
            res = completions.satisfy([("ok", lambda: (True, "ev"))], "p")
        self.assertTrue(res["satisfied"])
        self.assertEqual(res["advisory"], "model verdict malformed")

    def test_chat_retries_on_429(self):
        class Err(Exception):
            code = 429
        responses = [Err()] * 2 + [("done", {"completion_tokens": 1})]
        with mock.patch.object(completions, "get_key", return_value="k"), \
             mock.patch.object(completions.time, "sleep"), \
             mock.patch.object(completions.urllib.request, "urlopen", side_effect=responses[0] if False else None) as m:
            # simulate: first two attempts raise HTTPError(429), third succeeds
            import urllib.error
            side = [urllib.error.HTTPError("u", 429, "x", {}, None)] * 2
            def fake_urlopen(req, timeout=None):
                if len(side) > completions.chat.__wrapped_attempts__ if hasattr(completions.chat, "__wrapped_attempts__") else 0:
                    pass
                raise StopIteration
            # simpler: drive via state
            state = {"n": 0}
            def opener(req, timeout=None):
                state["n"] += 1
                if state["n"] <= 2:
                    raise urllib.error.HTTPError("u", 429, "too fast", {}, None)
                return FakeResp()
            class FakeResp:
                def read(self):
                    return json.dumps({"choices": [{"message": {"content": "hi"}}],
                                       "usage": {"completion_tokens": 1}}).encode()
                def __enter__(self): return self
                def __exit__(self, *a): return False
            with mock.patch.object(completions.urllib.request, "urlopen", opener):
                text, usage = completions.chat([{"role": "user", "content": "x"}], retries=4)
        self.assertEqual(text, "hi")
        self.assertEqual(state["n"], 3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
