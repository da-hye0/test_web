# 맛집·술집 찾기 서버 (FastAPI)
# 실행: uvicorn app.main:app --reload --port 3000
import json
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import ai, auth, config, context, places, store
from .cache import cached
from .fetch import client

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("matjip")

# 로그인 기능이 켜져 있으면(키가 하나라도 있으면) 첫 화면은 로그인, API도 로그인한 사람만
LOGIN_REQUIRED = bool(auth.ENABLED)


@asynccontextmanager
async def lifespan(_: FastAPI):
    log.info("🍻 맛집·술집 찾기: http://localhost:%s", config.PORT)
    log.info("   로그인: %s", ", ".join(auth.ENABLED) or "없음 (.env에 키를 넣으세요)")
    log.info("   데이터 소스: %s", "카카오 로컬 API" if places.PROVIDER == "kakao"
             else "OpenStreetMap (카카오 키를 .env에 넣으면 더 정확해집니다)")
    yield
    await client.aclose()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
# 1KB 넘는 응답은 gzip으로 보낸다 (가게 목록 JSON은 보통 10~20KB → 2~4KB)
app.add_middleware(GZipMiddleware, minimum_size=1024)
app.include_router(auth.router)


def send_json(status: int, body: dict, max_age: int = 0) -> JSONResponse:
    cache = f"private, max-age={max_age}" if status == 200 and max_age else "no-store"
    return JSONResponse(body, status_code=status, headers={"Cache-Control": cache})


@app.exception_handler(Exception)
async def on_error(request: Request, e: Exception) -> JSONResponse:
    log.error("[%s] %s", request.url.path, e)
    message = getattr(e, "user_message", None) or "외부 지도 서비스 호출에 실패했습니다. 잠시 후 다시 시도해주세요."
    return send_json(getattr(e, "status", 502), {"error": message})


def parse_coord(lat, lng) -> dict | None:
    """소수점 4자리(약 10m)로 반올림해서, 거의 같은 위치의 요청이 캐시를 같이 쓰게 한다"""
    try:
        lat, lng = float(lat), float(lng)
    except (TypeError, ValueError):
        return None
    if lat != lat or lng != lng or abs(lat) > 90 or abs(lng) > 180:
        return None
    return {"lat": round(lat, 4), "lng": round(lng, 4)}


@app.get("/api/config")
async def get_config() -> JSONResponse:
    return send_json(200, {
        "provider": places.PROVIDER,
        "kakaoJsKey": config.KAKAO_JS_KEY,
        "googleReviews": bool(config.GOOGLE_PLACES_KEY),
        "loginRequired": LOGIN_REQUIRED,
        "aiChat": bool(ai.GEMINI_KEY),
    })


# 그 밖의 /api/* 는 로그인한 사람만 (유료 API 쿼터 보호)
@app.middleware("http")
async def require_login(request: Request, call_next):
    path = request.url.path
    if (LOGIN_REQUIRED and path.startswith("/api/") and path not in ("/api/config", "/api/me")
            and not auth.get_user(request)):
        return send_json(401, {"error": "로그인이 필요해요."})
    return await call_next(request)


# ---------- 찜 ----------

def _user_key(request: Request) -> str | None:
    user = auth.get_user(request)
    return auth.user_key(user) if user else None


@app.get("/api/favorites")
async def list_favorites(request: Request) -> JSONResponse:
    key = _user_key(request)
    if not key:
        return send_json(401, {"error": "로그인이 필요해요."})
    return send_json(200, {"favorites": await store.list_favorites(key)})


@app.post("/api/favorites")
async def add_favorite(request: Request) -> JSONResponse:
    key = _user_key(request)
    if not key:
        return send_json(401, {"error": "로그인이 필요해요."})
    raw = await request.body()
    if len(raw) > 16 * 1024:
        return send_json(413, {"error": "요청이 올바르지 않아요."})
    try:
        body = json.loads(raw or b"{}")
    except ValueError:
        return send_json(400, {"error": "요청이 올바르지 않아요."})
    if not isinstance(body, dict):
        return send_json(400, {"error": "요청이 올바르지 않아요."})
    return send_json(200, {"favorite": await store.add_favorite(key, body)})


@app.delete("/api/favorites")
async def remove_favorite(request: Request, id: str = "") -> JSONResponse:
    key = _user_key(request)
    if not key:
        return send_json(401, {"error": "로그인이 필요해요."})
    await store.remove_favorite(key, id)
    return send_json(200, {"ok": True})


# ---------- 지도 데이터 ----------

@app.get("/api/route")
async def route(fromLat: str = "", fromLng: str = "", toLat: str = "", toLng: str = "") -> JSONResponse:
    if not config.KAKAO_KEY:
        return send_json(503, {"error": "길찾기는 카카오 REST API 키가 있어야 해요."})
    origin, dest = parse_coord(fromLat, fromLng), parse_coord(toLat, toLng)
    if not origin or not dest:
        return send_json(400, {"error": "출발지와 도착지 좌표가 필요해요."})
    key = f"route:{origin['lat']},{origin['lng']}>{dest['lat']},{dest['lng']}"
    return send_json(200, await cached(key, lambda: places.kakao_route(origin, dest)), 300)


@app.get("/api/geocode")
async def geocode(q: str = "") -> JSONResponse:
    q = q.strip()
    if not q:
        return send_json(400, {"error": "주소를 입력해주세요."})
    results = await cached(f"geo:{q}", lambda: places.geocode(q))
    return send_json(200, {"results": results}, 3600)


@app.get("/api/reverse")
async def reverse(lat: str = "", lng: str = "") -> JSONResponse:
    c = parse_coord(lat, lng)
    if not c:
        return send_json(400, {"error": "좌표가 올바르지 않습니다."})
    address = await cached(f"rev:{c['lat']},{c['lng']}", lambda: places.reverse(c["lat"], c["lng"]))
    return send_json(200, {"address": address}, 3600)


@app.get("/api/places")
async def nearby(lat: str = "", lng: str = "", radius: str = "", type: str = "") -> JSONResponse:
    c = parse_coord(lat, lng)
    if not c:
        return send_json(400, {"error": "좌표가 올바르지 않습니다."})
    try:
        r = int(float(radius)) or 500
    except ValueError:
        r = 500
    r = min(max(r, 100), 20000)
    kind = type if type in ("food", "bar") else "all"
    # 맛집/술집은 항상 같이 받아서 캐시하고, 종류 필터는 캐시된 결과에서 거른다
    found = await cached(f"places:{c['lat']},{c['lng']},{r}", lambda: places.nearby(c["lat"], c["lng"], r))
    result = found if kind == "all" else [p for p in found if p["kind"] == kind]
    return send_json(200, {"provider": places.PROVIDER, "places": result}, 300)


@app.get("/api/reviews")
async def reviews(name: str = "", address: str = "") -> JSONResponse:
    if not config.KAKAO_KEY:
        return send_json(503, {"error": "블로그 후기는 카카오 REST API 키가 있어야 볼 수 있어요."})
    name, address = name.strip()[:60], address.strip()[:120]
    if not name:
        return send_json(400, {"error": "가게 이름이 필요해요."})
    # 후기는 자주 바뀌지 않으니 일반 캐시(10분)보다 길게 둔다
    result = await cached(f"reviews:{name}|{places.area_of(address)}",
                          lambda: places.blog_reviews(name, address), places.REVIEW_TTL)
    return send_json(200, result, 3600)


@app.get("/api/google")
async def google(name: str = "", address: str = "", lat: str = "", lng: str = "") -> JSONResponse:
    if not config.GOOGLE_PLACES_KEY:
        return send_json(503, {"error": "구글 Places API 키가 설정되지 않았어요."})
    c = parse_coord(lat, lng)
    name = name.strip()[:60]
    if not c or not name:
        return send_json(400, {"error": "가게 이름과 좌표가 필요해요."})
    address = address.strip()[:120]
    place = await cached(f"google:{name}|{c['lat']},{c['lng']}",
                         lambda: places.google_rating(name, address, c["lat"], c["lng"]))
    return send_json(200, {"place": place})


# ---------- 지금 상황 (날씨·계절) ----------

@app.get("/api/now")
async def now(lat: str = "", lng: str = "") -> JSONResponse:
    c = parse_coord(lat, lng)
    snap = await context.snapshot(c["lat"] if c else None, c["lng"] if c else None)
    return send_json(200, {
        "date": snap["date"], "time": snap["time"], "season": snap["season"],
        "weather": snap["weather"], "tags": snap["tags"],
    }, 600)


# ---------- AI 채팅 추천 ----------

@app.post("/api/chat")
async def chat(request: Request) -> JSONResponse:
    raw = await request.body()
    if len(raw) > 32 * 1024:
        return send_json(413, {"error": "대화가 너무 길어요. 새로 시작해 주세요."})
    try:
        body = json.loads(raw or b"{}")
    except ValueError:
        return send_json(400, {"error": "요청이 올바르지 않아요."})
    messages = body.get("messages") if isinstance(body, dict) else None
    if not isinstance(messages, list):
        return send_json(400, {"error": "요청이 올바르지 않아요."})
    center_raw = body.get("center") or {}
    center = parse_coord(center_raw.get("lat"), center_raw.get("lng")) if isinstance(center_raw, dict) else None
    if center:
        center["label"] = str(center_raw.get("label") or "")[:120]
    return send_json(200, await ai.chat(messages, center))


@app.api_route("/api/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def not_found(rest: str) -> JSONResponse:
    return send_json(404, {"error": "Not found"})


# ---------- 정적 파일 (public/) ----------

class NoCacheStatic(StaticFiles):
    """바뀐 파일이 바로 보이도록 매번 확인하게 한다 (안 바뀌었으면 ETag로 304)"""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/", NoCacheStatic(directory=config.PUBLIC_DIR, html=True), name="public")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=config.PORT)
