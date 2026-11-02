# Google Stitch MCP 엔드포인트를 호출하는 작은 CLI
# 사용법: python scripts/stitch.py <tool_name> '<json args>'   (tool_name 생략 시 도구 목록)
import json
import os
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=False)
KEY = os.environ.get("STITCH_API_KEY")
if not KEY:
    sys.exit(".env 에 STITCH_API_KEY 를 설정하세요.")


def rpc(method: str, params: dict | None = None) -> dict:
    res = httpx.post(
        "https://stitch.googleapis.com/mcp",
        headers={"X-Goog-Api-Key": KEY, "Accept": "application/json, text/event-stream"},
        json={"jsonrpc": "2.0", "id": int(time.time() * 1000), "method": method, "params": params or {}},
        timeout=10 * 60,
    )
    text = res.text
    if not text.startswith("{"):
        text = [line for line in text.splitlines() if line.startswith("data:")][-1][5:]
    data = json.loads(text)
    if "error" in data:
        raise RuntimeError(json.dumps(data["error"], ensure_ascii=False))
    return data["result"]


def main() -> None:
    args = sys.argv[1:]
    if not args:
        for t in rpc("tools/list")["tools"]:
            schema = t["inputSchema"]
            print(f"{t['name']}\n  {t['description'].strip().splitlines()[0]}\n"
                  f"  args: {list(schema.get('properties', {}))} required: {schema.get('required', [])}")
        return
    result = rpc("tools/call", {"name": args[0], "arguments": json.loads(args[1]) if len(args) > 1 else {}})
    print(json.dumps(result.get("structuredContent", result), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        sys.exit(str(e))
