# 지도 데이터: 주소 검색, 근처 가게, 블로그 후기, 구글 별점, 길찾기
# - 카카오 REST API 키가 있으면 카카오 로컬 API 사용
# - 없으면 OpenStreetMap(Nominatim + Overpass) 사용
import asyncio
import html
import math
import re
import time

from . import config
from .errors import UserError
from .fetch import client, fetch_json

OVERPASS_MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]


def distance_meters(lat1: float, lng1: float, lat2: float, lng2: float) -> int:
    r = 6371000
    d_lat = math.radians(lat2 - lat1)
    d_lng = math.radians(lng2 - lng1)
    a = math.sin(d_lat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lng / 2) ** 2
    return round(2 * r * math.asin(math.sqrt(a)))


# ---------- 카카오 ----------

def _kakao_headers() -> dict:
    return {"Authorization": f"KakaoAK {config.KAKAO_KEY}"}


async def kakao_search(target: str, params: dict) -> dict:
    return await fetch_json(f"https://dapi.kakao.com/v2/search/{target}", params=params, headers=_kakao_headers(), timeout=8)


async def kakao(endpoint: str, params: dict) -> dict:
    return await fetch_json(f"https://dapi.kakao.com/v2/local/{endpoint}", params=params, headers=_kakao_headers())


async def kakao_geocode(q: str) -> list[dict]:
    addr = await kakao("search/address.json", {"query": q, "size": 5})
    from_addr = [{"name": d["address_name"], "lat": float(d["y"]), "lng": float(d["x"])} for d in addr["documents"]]
    if from_addr:
        return from_addr
    # "강남역", "홍대입구" 같은 장소명은 키워드 검색으로
    kw = await kakao("search/keyword.json", {"query": q, "size": 5})
    return [
        {
            "name": f"{d['place_name']} ({d.get('road_address_name') or d['address_name']})",
            "lat": float(d["y"]),
            "lng": float(d["x"]),
        }
        for d in kw["documents"]
    ]


async def kakao_reverse(lat: float, lng: float) -> str | None:
    data = await kakao("geo/coord2address.json", {"x": lng, "y": lat})
    if not data["documents"]:
        return None
    d = data["documents"][0]
    return (d.get("road_address") or {}).get("address_name") or (d.get("address") or {}).get("address_name")


async def kakao_all_pages(endpoint: str, params: dict) -> list[dict]:
    """카카오는 한 검색당 최대 45개(15개 x 3페이지).
    첫 페이지의 pageable_count로 남은 페이지 수를 알 수 있어서 2·3페이지는 동시에 요청한다."""
    first = await kakao(endpoint, {**params, "page": 1, "size": 15})
    if first["meta"]["is_end"]:
        return first["documents"]
    last_page = min(3, math.ceil(first["meta"]["pageable_count"] / 15))
    rest = await asyncio.gather(*(kakao(endpoint, {**params, "page": p, "size": 15}) for p in range(2, last_page + 1)))
    return [doc for page in [first, *rest] for doc in page["documents"]]


async def kakao_places(lat: float, lng: float, radius: int) -> list[dict]:
    base = {"x": lng, "y": lat, "radius": radius, "sort": "distance"}
    food, bars = await asyncio.gather(
        kakao_all_pages("search/category.json", {**base, "category_group_code": "FD6"}),
        kakao_all_pages("search/keyword.json", {**base, "query": "술집"}),
    )

    seen: set[str] = set()
    places = []
    for d in [*food, *bars]:
        if d["id"] in seen:
            continue
        seen.add(d["id"])
        category_path = d.get("category_name") or ""
        if "구내식당" in category_path:
            continue  # 관공서·회사 구내식당은 일반 손님이 못 간다
        is_bar = "술집" in category_path  # 예: 음식점 > 술집 > 호프,요리주점
        places.append({
            "id": f"kakao-{d['id']}",
            "name": d["place_name"],
            "kind": "bar" if is_bar else "food",
            "category": " > ".join(category_path.split(" > ")[1:]) or category_path,
            "address": d.get("road_address_name") or d.get("address_name"),
            "phone": d.get("phone") or None,
            "lat": float(d["y"]),
            "lng": float(d["x"]),
            "distance": int(d.get("distance") or 0),
            "url": d.get("place_url"),
        })
    return sorted(places, key=lambda p: p["distance"])


# ---------- OpenStreetMap ----------

async def osm_geocode(q: str) -> list[dict]:
    data = await fetch_json(
        "https://nominatim.openstreetmap.org/search",
        params={"q": q, "format": "json", "limit": 5, "countrycodes": "kr", "accept-language": "ko"},
        headers={"User-Agent": config.USER_AGENT},
    )
    return [{"name": d["display_name"], "lat": float(d["lat"]), "lng": float(d["lon"])} for d in data]


async def osm_reverse(lat: float, lng: float) -> str | None:
    data = await fetch_json(
        "https://nominatim.openstreetmap.org/reverse",
        params={"lat": lat, "lon": lng, "format": "json", "accept-language": "ko", "zoom": 18},
        headers={"User-Agent": config.USER_AGENT},
    )
    return data.get("display_name")


OSM_FOOD = ["restaurant", "fast_food", "food_court"]
OSM_BAR = ["bar", "pub", "biergarten"]

# 마지막으로 응답한 미러부터 시도해서, 죽은 미러 때문에 매번 기다리지 않게 한다
_overpass_index = 0
# 미러가 전부 실패하면 1분 동안은 다시 시도하지 않고 바로 실패 (매 검색마다 25초씩 기다리지 않게)
_overpass_down_until = 0.0


def _overpass_down(detail: str) -> UserError:
    return UserError(
        f"Overpass 실패: {detail}",
        "무료 지도 데이터 서버가 응답하지 않아요. .env에 KAKAO_REST_API_KEY를 넣으면 빠르고 안정적으로 동작해요.",
    )


async def osm_places(lat: float, lng: float, radius: int) -> list[dict]:
    global _overpass_index, _overpass_down_until
    if time.monotonic() < _overpass_down_until:
        raise _overpass_down("최근 실패로 건너뜀")
    amenities = "|".join(OSM_FOOD + OSM_BAR)
    query = f'[out:json][timeout:25];nwr["amenity"~"^({amenities})$"](around:{radius},{lat},{lng});out center tags 200;'

    data = None
    last_error: Exception | None = None
    for i in range(len(OVERPASS_MIRRORS)):
        index = (_overpass_index + i) % len(OVERPASS_MIRRORS)
        try:
            data = await fetch_json(
                OVERPASS_MIRRORS[index], method="POST", data={"data": query},
                headers={"User-Agent": config.USER_AGENT}, timeout=12,
            )
            _overpass_index = index
            break
        except Exception as e:  # noqa: BLE001 — 다음 미러로 넘어간다
            last_error = e
    if data is None:
        # 공개 Overpass 서버는 서버에서 보내는 자동 요청을 자주 거절한다 → 카카오 키 사용 권장
        _overpass_down_until = time.monotonic() + 60
        raise _overpass_down(str(last_error))

    places = []
    for el in data.get("elements", []):
        t = el.get("tags") or {}
        p_lat = el.get("lat", (el.get("center") or {}).get("lat"))
        p_lng = el.get("lon", (el.get("center") or {}).get("lon"))
        name = t.get("name:ko") or t.get("name")
        if not name or p_lat is None:
            continue
        address = " ".join(filter(None, [t.get("addr:city"), t.get("addr:district"), t.get("addr:street"), t.get("addr:housenumber")]))
        places.append({
            "id": f"osm-{el['type']}-{el['id']}",
            "name": name,
            "kind": "bar" if t.get("amenity") in OSM_BAR else "food",
            "category": " · ".join(filter(None, [t.get("amenity"), t.get("cuisine")])),
            "address": address or t.get("addr:full"),
            "phone": t.get("phone") or t.get("contact:phone"),
            "lat": p_lat,
            "lng": p_lng,
            "distance": distance_meters(lat, lng, p_lat, p_lng),
            "url": None,
        })
    return sorted(places, key=lambda p: p["distance"])


# ---------- 블로그 후기 (카카오 다음 블로그 검색 — 네이버·티스토리 블로그 글도 함께 검색됨) ----------

REVIEW_TTL = 6 * 60 * 60


def plain_text(value: str | None) -> str:
    return html.unescape(re.sub(r"<[^>]*>", "", value or "")).replace("\xa0", " ").strip()


def squash(value: str) -> str:
    return re.sub(r"\s+", "", value).lower()


def core_name(name: str) -> str:
    """"능동미나리 을지로점" → "능동미나리". 다른 가게 글을 거를 때 쓴다"""
    return re.sub(r"\s*\S+점$", "", name).strip() or name


def area_of(address: str | None) -> str:
    """"서울 중구 을지로 120" → "을지로" (동·도로명). 검색어를 동네로 좁히는 데 쓴다"""
    parts = (address or "").split()
    word = parts[2] if len(parts) > 2 else parts[1] if len(parts) > 1 else ""
    return re.sub(r"\d.*$", "", word)


def _with_area(name: str, address: str | None) -> str:
    area = area_of(address)
    return " ".join(filter(None, [name, "" if area in name else area]))


async def blog_reviews(name: str, address: str) -> dict:
    core = core_name(name)
    query = _with_area(name, address)
    data = await kakao_search("blog", {"query": query, "size": 20, "sort": "accuracy"})

    reviews = []
    for d in data["documents"]:
        review = {
            "title": plain_text(d.get("title")),
            "snippet": plain_text(d.get("contents")),
            "link": d.get("url"),
            "blogger": plain_text(d.get("blogname")),
            "date": d["datetime"][:10].replace("-", ".") if d.get("datetime") else None,
        }
        # 제목이나 본문에 가게 이름이 실제로 있는 글만 (다른 가게 글 섞임 방지)
        if squash(core) in squash(review["title"] + review["snippet"]):
            reviews.append(review)
    return {"query": query, "total": data["meta"]["total_count"], "reviews": reviews[:5]}


# ---------- 구글 별점·리뷰 (Places API New) ----------
# 유료 API라서 가게를 눌렀을 때만 1회 호출한다.
# 구글 약관상 리뷰 내용은 오래 저장하지 않는다 → 같은 요청이 몰릴 때만 막는 짧은 캐시(10분)

GOOGLE_FIELDS = ",".join([
    "places.displayName", "places.location", "places.rating", "places.userRatingCount",
    "places.googleMapsUri", "places.reviews",
])


async def google_rating(name: str, address: str, lat: float, lng: float) -> dict | None:
    res = await client.post(
        "https://places.googleapis.com/v1/places:searchText",
        headers={"X-Goog-Api-Key": config.GOOGLE_PLACES_KEY, "X-Goog-FieldMask": GOOGLE_FIELDS},
        json={
            # 동네 이름을 붙여야 같은 이름의 먼 가게 대신 이 동네 가게가 잡힌다 (예: "키싸" → "키싸 을지로")
            "textQuery": _with_area(name, address),
            "languageCode": "ko",
            "regionCode": "KR",
            "pageSize": 5,
            "locationBias": {"circle": {"center": {"latitude": lat, "longitude": lng}, "radius": 200}},
        },
        timeout=8,
    )
    try:
        data = res.json()
    except ValueError:
        data = {}
    if res.is_error:
        raise UserError(
            f"Google Places {res.status_code} {str(data.get('error', data))[:200]}",
            "구글 Places API (New)가 켜져 있지 않거나 키 제한에 막혔어요." if res.status_code == 403 else None,
        )

    # 카카오 가게와 같은 곳인지
    # 1) 150m 안 + 이름이 서로 포함 관계
    # 2) 이름이 달라도(구글엔 "TABACCHI"처럼 영어로 등록된 곳이 많음) 30m 안이면 같은 가게로 본다
    core = squash(core_name(name))
    candidates = sorted(
        ((pl, distance_meters(lat, lng, pl["location"]["latitude"], pl["location"]["longitude"])) for pl in data.get("places", [])),
        key=lambda c: c[1],
    )

    def same_name(pl: dict) -> bool:
        g = squash(core_name((pl.get("displayName") or {}).get("text", "")))
        return bool(g) and (g in core or core in g)

    match = next((pl for pl, d in candidates if d <= 150 and same_name(pl)), None) \
        or next((pl for pl, d in candidates if d <= 30), None)
    if not match:
        return None

    reviews = []
    for r in match.get("reviews", []):
        text = ((r.get("text") or {}).get("text") or (r.get("originalText") or {}).get("text") or "").strip()
        if text:
            author = r.get("authorAttribution") or {}
            reviews.append({
                "rating": r.get("rating"),
                "text": text,
                "author": author.get("displayName") or "구글 사용자",
                "authorUrl": author.get("uri"),
                "when": r.get("relativePublishTimeDescription", ""),
            })
    return {
        "rating": match.get("rating"),
        "count": match.get("userRatingCount", 0),
        "url": match.get("googleMapsUri"),
        "reviews": reviews,
    }


# ---------- 길찾기 (카카오모빌리티 자동차 길찾기) ----------
# 걷기 경로 API는 공개된 것이 없어서, 자동차 경로를 그리고 도보 시간은 경로 거리로 추정한다 (분당 67m ≈ 시속 4km)

WALK_M_PER_MIN = 67


async def kakao_route(origin: dict, dest: dict) -> dict:
    data = await fetch_json(
        "https://apis-navi.kakaomobility.com/v1/directions",
        params={
            "origin": f"{origin['lng']},{origin['lat']}",
            "destination": f"{dest['lng']},{dest['lat']}",
            "priority": "RECOMMEND",
        },
        headers=_kakao_headers(),
        timeout=8,
    )
    routes = data.get("routes") or []
    route = routes[0] if routes else None
    if not route or route.get("result_code") != 0:
        # 출발지와 도착지가 너무 가까우면(약 5m 이내) 경로가 없다고 나온다
        msg = (route or {}).get("result_msg")
        raise UserError(f"route {(route or {}).get('result_code')} {msg}", msg or "경로를 찾지 못했어요.")

    # vertexes는 [x1, y1, x2, y2, ...] → [[lat, lng], ...]
    path = [
        [road["vertexes"][i + 1], road["vertexes"][i]]
        for section in route["sections"]
        for road in section["roads"]
        for i in range(0, len(road["vertexes"]), 2)
    ]
    summary = route["summary"]
    return {
        "distance": summary["distance"],
        "driveMin": max(1, round(summary["duration"] / 60)),
        "walkMin": max(1, round(summary["distance"] / WALK_M_PER_MIN)),
        "taxi": (summary.get("fare") or {}).get("taxi"),
        "path": path,
    }


# 키가 있으면 카카오, 없으면 OpenStreetMap
PROVIDER = "kakao" if config.KAKAO_KEY else "osm"
geocode = kakao_geocode if config.KAKAO_KEY else osm_geocode
reverse = kakao_reverse if config.KAKAO_KEY else osm_reverse
nearby = kakao_places if config.KAKAO_KEY else osm_places
