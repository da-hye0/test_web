# 소셜 로그인 (카카오 · 네이버 · 구글) — OAuth 2.0 Authorization Code 방식
# - .env에 키가 있는 제공자만 켜진다
# - 세션은 서명된 쿠키(HMAC)라서 서버를 재시작하거나 여러 대로 늘려도 유지된다 (SESSION_SECRET 필요)
#   기존 Node 서버와 같은 형식이라, 같은 SESSION_SECRET이면 로그인이 그대로 유지된다
#
# 라우트
#   GET  /auth/{provider}           → 제공자 로그인 페이지로 이동
#   GET  /auth/{provider}/callback  → 코드 교환, 프로필 조회, 세션 쿠키 발급 후 / 로 이동
#   POST /auth/logout               → 세션 삭제
#   GET  /api/me                    → { user, providers }
import base64
import hashlib
import hmac
import json
import logging
import secrets
import time
from typing import Any, Awaitable, Callable
from urllib.parse import urlencode

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, RedirectResponse, Response

from .config import BASE_URL, env
from .fetch import client

log = logging.getLogger("auth")
router = APIRouter()


def _display_name(*candidates: Any) -> str:
    """이름이 없으면(동의항목 미설정 등) 이메일 앞부분, 그것도 없으면 계정 ID를 보여준다"""
    return next((str(v) for v in candidates if v and str(v).strip()), "")


def _email_id(email: str | None) -> str | None:
    return email.split("@")[0] if email else None


async def _get_json(url: str, token: str) -> dict:
    res = await client.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=10)
    if res.is_error:
        raise RuntimeError(f"{url} {res.status_code} {res.text[:200]}")
    return res.json()


async def _kakao_profile(token: str) -> dict:
    me = await _get_json("https://kapi.kakao.com/v2/user/me", token)
    account = me.get("kakao_account") or {}
    p = account.get("profile") or {}
    email = account.get("email")
    return {
        "id": str(me["id"]),
        "name": _display_name(p.get("nickname"), _email_id(email), me["id"]),
        "image": p.get("thumbnail_image_url") or p.get("profile_image_url"),
        "email": email,
    }


async def _naver_profile(token: str) -> dict:
    r = (await _get_json("https://openapi.naver.com/v1/nid/me", token))["response"]
    return {
        "id": r["id"],
        "name": _display_name(r.get("nickname"), r.get("name"), _email_id(r.get("email")), r["id"]),
        "image": r.get("profile_image"),
        "email": r.get("email"),
    }


async def _google_profile(token: str) -> dict:
    r = await _get_json("https://openidconnect.googleapis.com/v1/userinfo", token)
    return {
        "id": r["sub"],
        "name": _display_name(r.get("name"), _email_id(r.get("email")), r["sub"]),
        "image": r.get("picture"),
        "email": r.get("email"),
    }


PROVIDERS: dict[str, dict[str, Any]] = {
    "kakao": {
        "client_id": env("KAKAO_REST_API_KEY"),
        "client_secret": env("KAKAO_CLIENT_SECRET"),  # 콘솔에서 Client Secret을 "사용함"으로 했을 때만 필요
        "authorize_url": "https://kauth.kakao.com/oauth/authorize",
        "token_url": "https://kauth.kakao.com/oauth/token",
        "scope": "",
        "profile": _kakao_profile,
    },
    "naver": {
        "client_id": env("NAVER_CLIENT_ID"),
        "client_secret": env("NAVER_CLIENT_SECRET"),
        "authorize_url": "https://nid.naver.com/oauth2.0/authorize",
        "token_url": "https://nid.naver.com/oauth2.0/token",
        "scope": "",
        "profile": _naver_profile,
    },
    "google": {
        "client_id": env("GOOGLE_CLIENT_ID"),
        "client_secret": env("GOOGLE_CLIENT_SECRET"),
        "authorize_url": "https://accounts.google.com/o/oauth2/v2/auth",
        "token_url": "https://oauth2.googleapis.com/token",
        "scope": "openid email profile",
        "profile": _google_profile,
    },
}

# 키가 있는 제공자만 사용 (네이버·구글은 Client Secret까지 있어야 함)
ENABLED = [
    name for name, p in PROVIDERS.items()
    if p["client_id"] and (name == "kakao" or p["client_secret"])
]

# ---------- 세션 (서명된 쿠키) ----------
# 쿠키 값 = base64url(JSON{user, exp}) + "." + HMAC-SHA256. 서버에 저장하는 것이 없다.

SESSION_TTL_SEC = 7 * 24 * 60 * 60
STATE_TTL_SEC = 10 * 60

SECRET = env("SESSION_SECRET")
if not SECRET:
    SECRET = secrets.token_hex(32)
    log.warning("[auth] SESSION_SECRET이 없어 임시 키를 씁니다. 서버를 재시작하면 모두 로그아웃됩니다.")


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _sign(data: str) -> str:
    return _b64(hmac.new(SECRET.encode(), data.encode(), hashlib.sha256).digest())


def _now_ms() -> int:
    return int(time.time() * 1000)


def seal(payload: dict) -> str:
    data = _b64(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode())
    return f"{data}.{_sign(data)}"


def unseal(value: str | None) -> dict | None:
    data, _, mac = (value or "").partition(".")
    if not data or not mac or not hmac.compare_digest(mac, _sign(data)):
        return None
    try:
        payload = json.loads(base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)))
    except ValueError:
        return None
    return payload if payload.get("exp", 0) > _now_ms() else None


def _set_cookie(response: Response, name: str, value: str, max_age: int) -> None:
    response.set_cookie(
        name, value, max_age=max_age, path="/", httponly=True, samesite="lax",
        secure=BASE_URL.startswith("https://"),
    )


def get_user(request: Request) -> dict | None:
    session = unseal(request.cookies.get("sid"))
    return session.get("user") if session else None


def user_key(user: dict) -> str:
    """찜 등 사용자별 데이터의 키 (예: "kakao:123456")"""
    return f"{user['provider']}:{user['id']}"


# ---------- 라우트 ----------

def _redirect(location: str) -> RedirectResponse:
    return RedirectResponse(location, status_code=302, headers={"Cache-Control": "no-store"})


def _callback_url(name: str) -> str:
    return f"{BASE_URL}/auth/{name}/callback"


@router.get("/api/me")
async def me(request: Request) -> JSONResponse:
    return JSONResponse({"user": get_user(request), "providers": ENABLED}, headers={"Cache-Control": "no-store"})


@router.post("/auth/logout")
async def logout() -> Response:
    response = Response(status_code=204, headers={"Cache-Control": "no-store"})
    _set_cookie(response, "sid", "", 0)
    return response


@router.get("/auth/{name}")
async def start_login(name: str) -> Response:
    if name not in ENABLED:
        return _redirect("/?login=unavailable")
    p = PROVIDERS[name]
    state = secrets.token_urlsafe(24)
    params = {"response_type": "code", "client_id": p["client_id"], "redirect_uri": _callback_url(name), "state": state}
    if p["scope"]:
        params["scope"] = p["scope"]
    response = _redirect(f"{p['authorize_url']}?{urlencode(params)}")
    # state는 서명 쿠키에 담아 두고 콜백에서 비교 (로그인 요청 위조 방지)
    _set_cookie(response, "oauth_state",
                seal({"state": state, "provider": name, "exp": _now_ms() + STATE_TTL_SEC * 1000}), STATE_TTL_SEC)
    return response


@router.get("/auth/{name}/callback")
async def finish_login(name: str, request: Request) -> Response:
    if name not in ENABLED:
        return _redirect("/?login=unavailable")
    try:
        response = await _finish_login(name, request)
    except Exception as e:  # noqa: BLE001 — 어떤 이유로 실패해도 첫 화면으로 돌려보낸다
        log.error("[auth:%s] %s", name, e)
        response = _redirect("/?login=failed")
    _set_cookie(response, "oauth_state", "", 0)
    return response


async def _finish_login(name: str, request: Request) -> Response:
    params = request.query_params
    state = params.get("state")
    pending = unseal(request.cookies.get("oauth_state"))

    # 사용자가 동의 화면에서 취소한 경우 등
    if params.get("error"):
        return _redirect("/?login=cancelled")
    if not pending or pending.get("provider") != name or pending.get("state") != state:
        return _redirect("/?login=expired")

    p = PROVIDERS[name]
    body = {
        "grant_type": "authorization_code",
        "client_id": p["client_id"],
        "redirect_uri": _callback_url(name),
        "code": params.get("code") or "",
        "state": state,
    }
    if p["client_secret"]:
        body["client_secret"] = p["client_secret"]

    token_res = await client.post(p["token_url"], data=body, timeout=10)
    try:
        token = token_res.json()
    except ValueError:
        token = {}
    if token_res.is_error or not token.get("access_token"):
        raise RuntimeError(f"{name} 토큰 발급 실패: {token_res.status_code} {str(token)[:200]}")

    profile_fn: Callable[[str], Awaitable[dict]] = p["profile"]
    profile = await profile_fn(token["access_token"])
    # 카카오 프로필 사진이 http로 오는 경우가 있어 https로 (HTTPS 페이지에서 깨짐 방지)
    if (profile.get("image") or "").startswith("http://"):
        profile["image"] = "https://" + profile["image"][len("http://"):]
    response = _redirect("/")
    _set_cookie(response, "sid", seal({"user": {"provider": name, **profile}, "exp": _now_ms() + SESSION_TTL_SEC * 1000}),
                SESSION_TTL_SEC)
    return response
