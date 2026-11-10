# 사용자별 찜 목록 저장소
# - Cloud Run(K_SERVICE 환경변수가 있음): Firestore REST API, 인증은 메타데이터 서버 토큰
#   문서: favorites/{userKey} = { items: "<찜 목록 JSON 문자열>" }
#   APP_ENV가 dev/stg면 컬렉션을 favorites-dev / favorites-stg로 나눠 운영 데이터를 건드리지 않는다
# - 로컬: data/favorites.json
import json
import os
import re
import time
from urllib.parse import quote

from .config import DATA_DIR
from .errors import UserError
from .fetch import client

MAX_ITEMS = 300


class FileStore:
    def __init__(self) -> None:
        self.file = DATA_DIR / "favorites.json"
        try:
            self.db: dict = json.loads(self.file.read_text("utf-8"))
        except (OSError, ValueError):
            self.db = {}

    async def get(self, key: str) -> list[dict]:
        return self.db.get(key, [])

    async def put(self, key: str, items: list[dict]) -> None:
        self.db[key] = items
        self.file.parent.mkdir(parents=True, exist_ok=True)
        self.file.write_text(json.dumps(self.db, ensure_ascii=False), "utf-8")


METADATA = "http://metadata.google.internal/computeMetadata/v1"


def collection_name(app_env: str | None) -> str:
    """환경별 찜 컬렉션 (운영이나 값이 없으면 favorites)"""
    env = (app_env or "").strip().lower()
    return "favorites" if env in ("", "prd", "prod", "production") else f"favorites-{env}"


class FirestoreStore:
    def __init__(self) -> None:
        self.token: tuple[str, float] | None = None  # (값, 만료 시각)
        self.project_id = os.environ.get("GOOGLE_CLOUD_PROJECT")
        self.collection = collection_name(os.environ.get("APP_ENV"))

    async def _metadata(self, path: str):
        res = await client.get(f"{METADATA}/{path}", headers={"Metadata-Flavor": "Google"}, timeout=3)
        if res.is_error:
            raise RuntimeError(f"metadata {path} {res.status_code}")
        return res

    async def _auth(self) -> str:
        if not self.token or self.token[1] < time.time() + 60:
            t = (await self._metadata("instance/service-accounts/default/token")).json()
            self.token = (t["access_token"], time.time() + t["expires_in"])
        if not self.project_id:
            self.project_id = (await self._metadata("project/project-id")).text
        return self.token[0]

    def _doc_url(self, key: str) -> str:
        return (f"https://firestore.googleapis.com/v1/projects/{self.project_id}"
                f"/databases/(default)/documents/{self.collection}/{quote(key, safe='')}")

    async def get(self, key: str) -> list[dict]:
        token = await self._auth()
        res = await client.get(self._doc_url(key), headers={"Authorization": f"Bearer {token}"}, timeout=8)
        if res.status_code == 404:
            return []
        if res.is_error:
            raise RuntimeError(f"Firestore get {res.status_code} {res.text[:200]}")
        doc = res.json()
        return json.loads(((doc.get("fields") or {}).get("items") or {}).get("stringValue") or "[]")

    async def put(self, key: str, items: list[dict]) -> None:
        token = await self._auth()
        res = await client.patch(
            self._doc_url(key),
            headers={"Authorization": f"Bearer {token}"},
            json={"fields": {"items": {"stringValue": json.dumps(items, ensure_ascii=False)}}},
            timeout=8,
        )
        if res.is_error:
            raise RuntimeError(f"Firestore put {res.status_code} {res.text[:200]}")


backend = FirestoreStore() if os.environ.get("K_SERVICE") else FileStore()


def _str(value, limit: int) -> str | None:
    return None if value is None else str(value)[:limit]


def _number(value) -> float | None:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if n == n and abs(n) != float("inf") else None


def clean_place(p: dict) -> dict | None:
    """클라이언트가 보낸 가게 정보에서 필요한 필드만 저장"""
    lat, lng = _number(p.get("lat")), _number(p.get("lng"))
    if not p.get("id") or not p.get("name") or lat is None or lng is None:
        return None
    url = p.get("url") or ""
    return {
        "id": _str(p["id"], 80),
        "name": _str(p["name"], 80),
        "kind": "bar" if p.get("kind") == "bar" else "food",
        "category": _str(p.get("category"), 120),
        "address": _str(p.get("address"), 160),
        "phone": _str(p.get("phone"), 30),
        "lat": lat,
        "lng": lng,
        "url": _str(url, 300) if re.match(r"^https?://", str(url)) else None,
        "savedAt": int(time.time() * 1000),
    }


async def list_favorites(key: str) -> list[dict]:
    return await backend.get(key)


async def add_favorite(key: str, place: dict) -> dict:
    item = clean_place(place)
    if not item:
        raise UserError("bad place", "가게 정보가 올바르지 않아요.", status=400)
    items = [x for x in await backend.get(key) if x.get("id") != item["id"]]
    items.insert(0, item)
    await backend.put(key, items[:MAX_ITEMS])
    return item


async def remove_favorite(key: str, item_id: str) -> None:
    items = await backend.get(key)
    await backend.put(key, [x for x in items if x.get("id") != item_id])
