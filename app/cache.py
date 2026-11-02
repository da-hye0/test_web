# 외부 API 결과 캐시
# - 같은 키로 동시에 들어온 요청은 외부 API를 한 번만 부른다
# - 실패는 캐시하지 않는다
# - 500개를 넘으면 가장 오래 안 쓴 것부터 버린다 (LRU)
import asyncio
import time
from collections import OrderedDict
from typing import Any, Awaitable, Callable

CACHE_TTL = 10 * 60
MAX_ITEMS = 500

_items: "OrderedDict[str, tuple[float, asyncio.Task]]" = OrderedDict()


async def cached(key: str, fn: Callable[[], Awaitable[Any]], ttl: float = CACHE_TTL) -> Any:
    hit = _items.get(key)
    if hit and time.monotonic() - hit[0] < ttl:
        _items.move_to_end(key)
        task = hit[1]
    else:
        task = asyncio.ensure_future(fn())
        _items[key] = (time.monotonic(), task)
        if len(_items) > MAX_ITEMS:
            _items.popitem(last=False)
    try:
        # 한 요청이 끊겨도 같은 결과를 기다리는 다른 요청은 계속 받을 수 있게 shield
        return await asyncio.shield(task)
    except Exception:
        current = _items.get(key)
        if current and current[1] is task:
            del _items[key]
        raise
