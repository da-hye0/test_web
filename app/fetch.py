# 외부 API 호출용 공용 HTTP 클라이언트
from typing import Any

import httpx

client = httpx.AsyncClient(follow_redirects=True)


async def fetch_json(url: str, *, method: str = "GET", timeout: float = 15, **kwargs: Any) -> Any:
    res = await client.request(method, url, timeout=timeout, **kwargs)
    if res.is_error:
        raise RuntimeError(f"{res.status_code} {res.reason_phrase} {res.text[:200]}")
    return res.json()
