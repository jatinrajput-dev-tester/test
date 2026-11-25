import json
import sys
import time
import requests

KEY   = "sk-21ba7124d04724305c1af021caa63d18b22becd045ff52d50c0659bde5ba4238"
MODEL = "gpt-6.1-sol"
BASE  = "https://api.xingchiapi.com/v1"
PROMPT = "Write a full game in python about love in 100 lines o code ."

SID = "0f1c2b7e-1111-4222-8333-944455556666"

HEADER_SETS = {
    "codex_full": {
        "User-Agent": "codex_cli_rs/0.46.0 (Windows 11 Pro; x86_64) WindowsTerminal",
        "originator": "codex_cli_rs",
        "version": "0.46.0", 
        "session_id": SID,
        "Accept": "application/json",
    },
    "codex_beta": {
        "User-Agent": "codex_cli_rs/0.46.0 (Windows 11 Pro; x86_64) WindowsTerminal",
        "originator": "codex_cli_rs",
        "version": "0.46.0",
        "session_id": SID,
        "OpenAI-Beta": "responses=experimental",
        "Accept": "application/json",
    },
    "codex_conv": {
        "User-Agent": "codex_cli_rs/0.46.0 (Windows 11 Pro; x86_64) WindowsTerminal",
        "originator": "codex_cli_rs",
        "conversation_id": SID,
        "session_id": SID,
        "Accept": "application/json",
    },
    "claude_code": {
        "User-Agent": "claude-cli/1.0.60 (external, cli)",
        "x-app": "cli",
        "anthropic-version": "2023-06-01",
        "Accept": "application/json",
    },
    "opencode": {
        "User-Agent": "opencode/1.0.0",
        "x-app": "opencode",
        "Accept": "application/json",
    },
    "plain": {
        "Accept": "application/json",
    },
}

BODIES = {
    "string_input": lambda stream: {
        "model": MODEL, "input": "hi", "stream": stream, "store": False,
        "max_output_tokens": 16,
    },
    "array_input": lambda stream: {
        "model": MODEL,
        "input": [{"role": "user", "content": [{"type": "input_text", "text": "hi"}]}],
        "instructions": "You are a helpful assistant.",
        "stream": stream, "store": False, "max_output_tokens": 16,
    },
}

PATHS = ["/responses", "/v1/responses"]


def probe():
    print("== probing /v1/responses unlock ==", file=sys.stderr)
    for path in PATHS:
        for hname, hset in HEADER_SETS.items():
            for bname, mk in BODIES.items():
                url = (BASE + path) if path.startswith("/v1") else ("https://api.xingchiapi.com" + path)
                url = url.replace("/v1/v1/", "/v1/")   # BASE already has /v1
                headers = {"Authorization": f"Bearer {KEY}",
                           "Content-Type": "application/json", **hset}
                try:
                    r = requests.post(url, headers=headers, json=mk(False), timeout=60)
                except Exception as e:
                    print(f"  {path:15} {hname:12} {bname:12} EXC {e}", file=sys.stderr)
                    continue
                body = r.text[:160].replace("\n", " ")
                print(f"  {url:48} {hname:11} {bname:12} -> {r.status_code}  {body!r}",
                      file=sys.stderr)
                if r.status_code == 200:
                    print(f"\n>>> WORKING: path={url}\n    headers={hname}\n    body={bname}\n",
                          file=sys.stderr)
                    return url, hset, bname
    print("\n!! nothing unlocked it -- paste the block above\n", file=sys.stderr)
    return None


class Tps:
    def __init__(self):
        self.t0 = time.perf_counter()
        self.first = None
        self.last = None
        self.n = 0

    def tick(self, text):
        now = time.perf_counter()
        if self.first is None:
            self.first = now
        self.last = now
        self.n += 1
        print(text, end="", flush=True)
        d = now - self.first
        print(f"\r[{self.n / d if d > 0 else 0:6.1f} tok/s | {self.n:4d} tok | {d:5.1f}s]",
              end="", file=sys.stderr)

    def summary(self, tokens=None):
        wall = time.perf_counter() - self.t0
        decode = (self.last - self.first) if self.first else 0.0
        n = tokens if tokens is not None else self.n
        print("\n" + "-" * 55)
        print(f"output tokens    : {n} ({'usage' if tokens is not None else 'deltas'})")
        print(f"TTFT             : {(self.first - self.t0) if self.first else float('nan'):.3f} s")
        print(f"decode time      : {decode:.3f} s")
        print(f"decode speed     : {n / decode if decode > 0 else 0:.2f} tok/s")
        print(f"end-to-end speed : {n / wall if wall > 0 else 0:.2f} tok/s")
        print(f"total wall time  : {wall:.3f} s")
        print("-" * 55)


def stream_responses(url, hset):
    headers = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json",
               "Accept": "text/event-stream", **hset}
    payload = {
        "model": MODEL,
        "input": PROMPT,
        "instructions": "You are a helpful assistant.",
        "stream": True,
        "store": False,
    }

    tps = Tps()
    out_tokens = None

    with requests.post(url, headers=headers, json=payload, stream=True, timeout=300) as r:
        if r.status_code != 200:
            print(f"stream failed {r.status_code}: {r.text[:400]}", file=sys.stderr)
            return
        for raw in r.iter_lines(decode_unicode=True):
            if not raw or not raw.startswith("data:"):
                continue
            data = raw[5:].strip()
            if data == "[DONE]":
                break
            try:
                ev = json.loads(data)
            except json.JSONDecodeError:
                continue
            t = ev.get("type")
            if t == "response.output_text.delta":
                tps.tick(ev.get("delta", ""))
            elif t == "response.completed":
                out_tokens = ((ev.get("response") or {}).get("usage") or {}).get("output_tokens")
            elif t in ("response.failed", "error"):
                print(f"\n[{t}] {json.dumps(ev)[:400]}", file=sys.stderr)
                break
    tps.summary(out_tokens)


if __name__ == "__main__":
    hit = probe()
    if hit:
        url, hset, _ = hit
        stream_responses(url, hset)