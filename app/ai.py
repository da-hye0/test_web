# AI 채팅 추천 (Google Gemini API)
# "여자 10명이서 갈만한 중구 음식점" 같은 질문을 받으면, Gemini가 아래 도구로 실제 가게를 찾아보고 추천한다.
#   - search_places : 카카오 키워드 검색 (동네·메뉴·분위기 등)
#   - search_nearby : 지금 지도 중심 근처의 맛집·술집
#   - get_reviews   : 가게 블로그 후기 (단체석·룸·예약 같은 정보 확인용)
# 가게 이름·주소는 도구 결과에 있는 것만 쓰게 해서, 없는 가게를 지어내지 않게 한다.
import asyncio
import json
import logging
import re

import httpx

from . import config, context, places
from .config import env
from .errors import UserError
from .fetch import client

log = logging.getLogger("ai")

GEMINI_KEY = env("GEMINI_API_KEY")
# 빠른 모델을 먼저 쓰고, 혼잡(503)·지연·사용 불가일 때만 다음 모델로 넘어간다
GEMINI_MODELS = [m for m in dict.fromkeys([env("GEMINI_MODEL") or "gemini-flash-lite-latest", "gemini-3.5-flash"])]
GEMINI_TIMEOUT = 30

MAX_ROUNDS = 6  # 도구를 부르고 다시 생각하는 횟수 상한 (무료 한도·응답 시간 보호)
MAX_HISTORY = 10
MAX_TEXT = 1000

SYSTEM_PROMPT = """너는 한국의 맛집·술집 추천 도우미야. 사용자의 상황(인원, 성별·연령대, 목적, 지역, 예산, 분위기)에 맞는 가게를 찾아 추천해.

찾는 순서
1. 후보 모으기: search_places는 가게 이름·메뉴·지역으로만 검색된다. "단체석", "모임", "분위기" 같은 조건어를 넣으면 결과가 없다.
   "중구 한식", "을지로 파스타", "명동 중식당", "성수 와인바"처럼 [지역 + 메뉴 종류]로 검색해. 메뉴를 바꿔 2~3개를 한 번에 같이 호출해.
   어떤 메뉴로 검색할지는 아래 '누구와, 무슨 자리인지'와 '지금 날씨'를 보고 골라.
   search_nearby는 지도 위치 기준이다. 사용자가 동네·역·건물을 말하지 않고 "근처", "여기"라고 할 때만 써.
2. 결과에서 주소가 사용자가 말한 지역인 곳만 남겨. (이름만 비슷한 다른 지역 지점은 빼)
3. 인원이 많거나(6명 이상) 룸·예약·분위기 같은 조건이 있으면, 유력한 후보 3~4곳을 get_reviews로 한 번에 같이 확인해서 근거로 써.
4. 그다음 바로 답해. 검색은 많아야 두 번, 후기 확인은 한 번이면 충분하다.

어디서 (장소 기준)
- 사용자가 동네·역·건물·주소를 말하면 (예: "동대문역사공원역 근처") 반드시 그곳 기준으로 찾아. 지도 위치는 장소를 말하지 않았을 때만 쓴다.
- 역 이름은 정식 이름으로 검색해 (동대문역사공원역 → 동대문역사문화공원역).

언제 (시간 기준)
- 사용자가 시간을 말하지 않으면 지금 바로 가는 것으로 본다.
- "내일 점심", "토요일 저녁", "이따 7시"처럼 시간을 말하면 그 시간 기준으로 골라. 이때 '지금 상황'의 '시간 주의'(지금 시각 기준 영업)는 무시하고,
  그 시간대에 맞는 곳(점심이면 점심 장사하는 식당, 백반·국수·덮밥·한식 등)을 고르고, 날씨는 '내일 예보'처럼 그날 예보를 써.
- 답의 첫 문장에서 언제·어디 기준인지 짚어 줘. (예: "내일 점심, 동대문역사문화공원역 근처로 골라봤어요.")

누구와, 무슨 자리인지 (메뉴를 고르는 첫 기준)
- 연인·남자친구·여자친구·썸·데이트·기념일: 분위기 있는 2인 자리. 파스타·이탈리안, 양식·비스트로, 일식(스시·오마카세·이자카야), 와인바·칵테일바, 분위기 좋은 한식 주점 같은 곳.
  고깃집·곱창·무한리필·회식형 대형 식당·기사식당은 사용자가 원할 때만 넣어.
- 친구 몇 명: 같이 나눠 먹기 좋은 곳 (고기, 곱창, 포차, 중식, 타코·피자 등) 다양하게.
- 회식·단체(6명 이상): 단체석·룸이 있을 만한 한식·고깃집·중식당. 후기로 단체석 확인.
- 혼밥: 1인석·바 좌석이 있는 덮밥, 라멘, 국밥, 김밥 같은 곳.
- 가족·부모님: 조용하고 메뉴가 무난한 한정식, 한식, 중식.
- 3~5곳을 추천할 때는 같은 종류만 고르지 말고 메뉴를 섞어 선택지를 줘.

규칙
- 가게는 반드시 도구로 찾은 결과 안에서만 추천해. 이름·주소를 지어내지 마.
- 추천은 3~5곳. 추천 이유는 가게마다 구체적인 한 문장. 후기에서 확인한 내용이면 "후기에 따르면"처럼 밝혀.
- 후기에서 확인 못 한 조건(예: 10명 수용 가능 여부)은 단정하지 말고 "방문 전에 전화로 단체 예약 가능한지 확인해 보세요"처럼 안내해.
- 한국어로, 친근하고 짧게. 마크다운(**, #, 표)은 쓰지 마.
- 맛집·술집과 관계없는 요청이면 정중하게 이 서비스에서 도울 수 있는 일을 알려 줘.

지금의 날씨·기온·계절·시간 (아래 '지금 상황'에 있다)
- 사용자가 따로 말하지 않으면 지금(또는 사용자가 말한 시간의) 상황에 어울리는 곳을 우선해. 예를 들면
  비·눈: 파전·막걸리, 국밥, 칼국수처럼 비 오는 날 생각나는 메뉴. 실내이고 역에서 가까운 곳.
  쌀쌀하거나 추움(체감 10°C 이하): 국물 요리(국밥, 전골, 감자탕, 어묵탕), 따뜻한 실내. 야외 포차·루프탑은 피해.
  더움(체감 27°C 이상): 냉면, 물회, 콩국수, 시원한 맥주. 에어컨 있는 실내.
  미세먼지 나쁨: 야외·테라스는 피하고 실내 위주로.
  늦은 밤(22시 이후): 식당은 대부분 닫았다. 이 시간엔 연인이든 누구든 술집·이자카야·포차·와인바, 늦게까지 하는 고깃집·국밥·해장국·24시간 식당만 추천해.
    양식·이탈리안·브런치·한정식·카페는 빼. 영업시간은 확인할 수 없으니 "늦게까지 하는지 확인해 보세요"라고 안내해.
  저녁 8~10시: 식당은 라스트 오더가 가까우니 그 점을 짚어 줘.
  주말 저녁: 인기 있는 곳은 붐빌 수 있으니 예약·웨이팅을 언급해.
- 지금 바로 가는 거라면 지금 문 열었을 곳인지가 가장 먼저다 ('시간 주의'를 따른다). 다른 시간을 말했으면 그 시간에 문 열었을 곳이 먼저다.
  그다음이 사용자가 원하는 메뉴·조건, 그다음이 누구와 가는 자리인지다. 날씨는 그 안에서 고르는 정도로만.
  (예: 쌀쌀한 날 데이트라면 국밥집이 아니라 따뜻한 분위기의 이탈리안·일식·와인바를, 비 오는 날 데이트라면 분위기 좋은 전집·이자카야를)
- 첫 문장에서 날씨를 한마디로 자연스럽게 짚어 줘. (예: "쌀쌀한 늦가을 밤이라 늦게까지 하는 따뜻한 곳 위주로 골라봤어요.") 날씨 설명을 길게 늘어놓지는 마."""

CHAT_FORMAT = """

답 형식: 마지막 답은 아래 JSON 하나만 출력해. 다른 말이나 코드블록 표시(```)는 쓰지 마.
{"intro": "언제·어디 기준과 고른 기준을 한두 문장으로 (날씨를 한마디 곁들여)",
 "picks": [{"id": "도구 결과의 id 그대로", "why": "이 가게를 고른 이유 한 문장"}],
 "tip": "방문 전 팁 한 문장, 없으면 빈 문자열"}
- picks는 추천 순서대로 3~5곳. 가게 이름·종류·주소는 앱이 따로 보여 주니 why에 다시 쓰지 마.
- 가게 추천이 아닌 질문(인사, 서비스 문의 등)이면 picks를 빈 배열로 두고 intro에 답을 써."""

TOOLS = [{
    "functionDeclarations": [
        {
            "name": "search_places",
            "description": "카카오 지도에서 음식점·술집을 검색한다. 가게 이름·메뉴·지역 단어로만 검색되므로 '중구 한식', '을지로 고기집'처럼 [지역 + 메뉴]로 넣는다. '단체석' 같은 조건어는 넣지 않는다.",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "query": {"type": "STRING", "description": "검색어 (지역 + 메뉴/조건)"},
                    "kind": {"type": "STRING", "enum": ["any", "food", "bar"], "description": "food=음식점, bar=술집, any=둘 다"},
                },
                "required": ["query"],
            },
        },
        {
            "name": "search_nearby",
            "description": "사용자가 지금 보고 있는 지도 중심 근처의 음식점·술집을 가까운 순으로 가져온다.",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "kind": {"type": "STRING", "enum": ["any", "food", "bar"]},
                    "radius": {"type": "INTEGER", "description": "반경(미터), 300~2000"},
                },
            },
        },
        {
            "name": "get_reviews",
            "description": "가게의 블로그 후기 요약을 가져온다. 단체석, 룸, 예약, 분위기, 가격 같은 정보를 확인할 때 쓴다.",
            "parameters": {
                "type": "OBJECT",
                "properties": {"id": {"type": "STRING", "description": "search_places/search_nearby 결과의 id"}},
                "required": ["id"],
            },
        },
    ]
}]


def _brief(p: dict) -> dict:
    """AI에게 넘길 가게 정보 (토큰 절약을 위해 필요한 것만)"""
    out = {"id": p["id"], "name": p["name"], "kind": p["kind"], "category": p.get("category"), "address": p.get("address")}
    if p.get("distance") is not None:
        out["distance_m"] = p["distance"]
    return out


class Session:
    """한 번의 질문 동안 AI가 찾아본 가게들을 기억한다 (후기 조회·지도 표시용)"""

    def __init__(self, center: dict | None):
        self.center = center
        self.found: dict[str, dict] = {}

    def remember(self, items: list[dict]) -> list[dict]:
        for p in items:
            self.found[p["id"]] = p
        return [_brief(p) for p in items]

    async def search_places(self, query: str = "", kind: str = "any") -> dict:
        query = str(query).strip()[:60]
        if not query:
            return {"error": "검색어가 비어 있어요."}
        if not config.KAKAO_KEY:
            return {"error": "카카오 키가 없어 검색할 수 없어요."}
        params = {"query": query, "size": 15, "category_group_code": "FD6"}
        if self.center:
            # 위치를 주면 거리도 같이 온다 (정렬은 정확도순 그대로)
            params |= {"x": self.center["lng"], "y": self.center["lat"]}
        data = await places.kakao("search/keyword.json", params)
        items = []
        for d in data["documents"]:
            category_path = d.get("category_name") or ""
            item_kind = "bar" if "술집" in category_path else "food"
            if kind in ("food", "bar") and item_kind != kind:
                continue
            items.append({
                "id": f"kakao-{d['id']}",
                "name": d["place_name"],
                "kind": item_kind,
                "category": " > ".join(category_path.split(" > ")[1:]) or category_path,
                "address": d.get("road_address_name") or d.get("address_name"),
                "phone": d.get("phone") or None,
                "lat": float(d["y"]),
                "lng": float(d["x"]),
                "distance": int(d["distance"]) if d.get("distance") else None,
                "url": d.get("place_url"),
            })
        if not items:
            return {"results": [], "hint": "결과가 없어요. 조건어를 빼고 '중구 한식'처럼 지역 + 메뉴로 다시 검색하세요."}
        return {"results": self.remember(items)}

    async def search_nearby(self, kind: str = "any", radius: int = 1000) -> dict:
        if not self.center:
            return {"error": "지도 위치를 알 수 없어요. 지역 이름으로 search_places를 써 주세요."}
        try:
            r = min(max(int(radius), 300), 2000)
        except (TypeError, ValueError):
            r = 1000
        found = await places.nearby(self.center["lat"], self.center["lng"], r)
        if kind in ("food", "bar"):
            found = [p for p in found if p["kind"] == kind]
        return {"results": self.remember(found[:25])}

    async def get_reviews(self, id: str = "", place_id: str = "") -> dict:  # noqa: A002 — 도구 인자 이름 그대로
        p = self.found.get(str(id or place_id))
        if not p:
            return {"error": "먼저 검색한 결과의 id를 넣어 주세요."}
        if not config.KAKAO_KEY:
            return {"error": "카카오 키가 없어 후기를 볼 수 없어요."}
        result = await places.blog_reviews(p["name"], p.get("address") or "")
        return {
            "place": p["name"],
            "reviews": [{"title": r["title"], "snippet": r["snippet"][:200], "date": r["date"]} for r in result["reviews"]],
        }

    async def call(self, name: str, args: dict) -> dict:
        handler = {"search_places": self.search_places, "search_nearby": self.search_nearby,
                   "get_reviews": self.get_reviews}.get(name)
        if not handler:
            return {"error": f"알 수 없는 도구: {name}"}
        try:
            return await handler(**(args or {}))
        except TypeError:
            return {"error": "도구 인자가 올바르지 않아요."}
        except Exception as e:  # noqa: BLE001 — 도구 실패는 AI에게 알려서 다른 방법을 찾게 한다
            log.warning("[ai tool %s] %s", name, e)
            return {"error": "검색 중 오류가 났어요. 다른 검색어로 시도해 보세요."}


async def _generate(contents: list[dict], system: str, allow_tools: bool = True) -> dict:
    body = {"systemInstruction": {"parts": [{"text": system}]}, "contents": contents, "tools": TOOLS}
    if not allow_tools:
        # 마지막 차례: 더 찾지 말고 지금까지 찾은 것으로 답하게 한다
        body["toolConfig"] = {"functionCallingConfig": {"mode": "NONE"}}
    for i, model in enumerate(GEMINI_MODELS):
        last = i == len(GEMINI_MODELS) - 1
        try:
            res = await client.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                headers={"x-goog-api-key": GEMINI_KEY}, json=body, timeout=GEMINI_TIMEOUT,
            )
        except httpx.TimeoutException:
            log.warning("[ai] %s 응답 지연", model)
            if last:
                raise UserError("Gemini timeout", "AI가 너무 오래 생각하고 있어요. 잠시 후 다시 물어봐 주세요.", status=504)
            continue
        if res.status_code in (404, 503) and not last:
            log.warning("[ai] %s 사용 불가(%s), 다음 모델로", model, res.status_code)
            continue
        if res.status_code == 402:
            raise UserError("Gemini 402 크레딧 없음", "AI 키의 결제 크레딧이 없어요. AI Studio에서 무료 프로젝트 키로 바꾸거나 크레딧을 충전해 주세요.", status=402)
        if res.status_code == 429:
            raise UserError("Gemini 429", "AI 무료 사용량을 잠깐 다 썼어요. 1분쯤 뒤에 다시 물어봐 주세요.", status=429)
        if res.is_error:
            raise UserError(f"Gemini {res.status_code} {res.text[:300]}", "AI 응답을 받지 못했어요. 잠시 후 다시 시도해 주세요.")
        return res.json()
    raise UserError("Gemini 모델 없음", "AI 응답을 받지 못했어요. 잠시 후 다시 시도해 주세요.")


def _history(messages: list) -> list[dict]:
    """브라우저가 보낸 이전 대화(텍스트만)를 Gemini 형식으로"""
    contents = []
    for m in messages[-MAX_HISTORY:]:
        if not isinstance(m, dict):
            continue
        text = str(m.get("text") or "").strip()[:MAX_TEXT]
        role = "model" if m.get("role") == "assistant" else "user"
        if text:
            contents.append({"role": role, "parts": [{"text": text}]})
    # Gemini는 대화가 user로 시작하고 user로 끝나야 한다
    while contents and contents[0]["role"] != "user":
        contents.pop(0)
    return contents


async def chat(messages: list, center: dict | None) -> dict:
    if not GEMINI_KEY:
        raise UserError("no GEMINI_API_KEY", "AI 키가 설정되지 않았어요. .env에 GEMINI_API_KEY를 넣어 주세요.", status=503)
    contents = _history(messages)
    if not contents or contents[-1]["role"] != "user":
        raise UserError("empty chat", "질문을 입력해 주세요.", status=400)

    snap = await context.snapshot(center["lat"] if center else None, center["lng"] if center else None)
    system = SYSTEM_PROMPT + "\n\n지금 상황\n" + context.describe(snap)
    if center:
        system += f"\n사용자가 지금 보고 있는 지도 위치 (장소를 말하지 않았을 때만 기준): {center.get('label') or '알 수 없음'} (위도 {center['lat']}, 경도 {center['lng']})"
    text, trace, session = await _run(contents, system + CHAT_FORMAT, center)
    return {**_chat_answer(text, session.found), "trace": trace}


def _chat_answer(text: str, found: dict[str, dict]) -> dict:
    """AI의 JSON 답을 화면용으로: 앱은 intro·picks·tip을 카드로, 웹은 reply(이어 붙인 글)와 places를 쓴다.
    JSON이 아니면 예전처럼 글 전체를 답으로 보고 글에 나온 가게를 찾는다."""
    data = _parse_json(text) or {}
    intro = str(data.get("intro") or "").strip()
    picks = []
    for item in data.get("picks") or []:
        place = found.get(str(item.get("id"))) if isinstance(item, dict) else None
        if place and all(p["place"]["id"] != place["id"] for p in picks):  # 지어낸 id·중복은 버린다
            picks.append({"place": place, "why": str(item.get("why") or "").strip()})
    tip = str(data.get("tip") or "").strip()
    if not intro and not picks:
        reply = text.strip() or "알맞은 답을 만들지 못했어요. 질문을 조금 바꿔서 다시 물어봐 주세요."
        return {"reply": reply, "places": _mentioned(reply, found), "intro": reply, "picks": [], "tip": ""}
    listed = "\n".join(f"{i}. {p['place']['name']} — {p['why']}" for i, p in enumerate(picks, 1))
    return {"reply": "\n\n".join(part for part in (intro, listed, tip) if part),
            "places": [p["place"] for p in picks], "intro": intro, "picks": picks, "tip": tip}


def _trace_line(call: dict, result: dict, session: Session) -> str:
    """AI가 한 일을 사람이 읽는 한 줄로 (앱에서 '뭉치가 한 일'로 보여준다)"""
    name, args = call.get("name"), call.get("args") or {}
    count = len(result.get("results") or [])
    if name == "search_places":
        return f"'{args.get('query', '')}' 검색 · {count}곳"
    if name == "search_nearby":
        return f"근처 {args.get('radius', 1000)}m 둘러보기 · {count}곳"
    if name == "get_reviews":
        place = session.found.get(str(args.get("id") or args.get("place_id")))
        return f"{place['name'] if place else '가게'} 후기 읽기"
    return str(name)


async def _run(contents: list[dict], system: str, center: dict | None) -> tuple[str, list[str], Session]:
    """AI가 도구를 부르며 찾아보고, 최종 답(텍스트)과 한 일 목록을 돌려준다"""
    session = Session(center)
    trace: list[str] = []
    for round_no in range(MAX_ROUNDS):
        data = await _generate(contents, system)
        candidate = (data.get("candidates") or [{}])[0]
        parts = (candidate.get("content") or {}).get("parts") or []
        calls = [p["functionCall"] for p in parts if "functionCall" in p]

        if not calls:
            reply = "".join(p.get("text", "") for p in parts if not p.get("thought")).strip()
            if not reply:
                log.warning("[ai] 빈 응답: %s", candidate.get("finishReason"))
            return reply, trace, session

        # AI가 부른 도구들을 동시에 실행하고, 결과를 한 번에 돌려준다 (생각 서명 등 원래 응답은 그대로 보존)
        contents.append({"role": "model", "parts": parts})
        log.info("[ai] %d번째: %s", round_no + 1, ", ".join(f"{c.get('name')}({c.get('args')})" for c in calls))
        results = await asyncio.gather(*(session.call(c.get("name", ""), c.get("args") or {}) for c in calls))
        responses = []
        for c, result in zip(calls, results):
            trace.append(_trace_line(c, result, session))
            response = {"name": c.get("name", ""), "response": result}
            if c.get("id"):
                response["id"] = c["id"]
            responses.append({"functionResponse": response})
        contents.append({"role": "user", "parts": responses})

    # 도구를 너무 많이 부르면: 더 찾지 말고 지금까지 찾은 것으로 답하게 한다
    contents.append({"role": "user", "parts": [{"text": "이제 더 검색하지 말고, 지금까지 찾은 가게로 바로 답해 줘."}]})
    data = await _generate(contents, system, allow_tools=False)
    parts = ((data.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
    return "".join(p.get("text", "") for p in parts if not p.get("thought")).strip(), trace, session


PLAN_PROMPT = """

지금부터는 대화가 아니라 '코스 짜기'야. 사용자가 고른 동행·분위기·메모와 시간·날씨를 보고 코스를 짜.
- 메모에 장소나 시간이 있으면 (예: "내일 점심 동대문역사공원역") 그 장소·시간 기준으로. 없으면 지도 위치 근처에서 지금 바로 갈 코스로.
- 코스는 1~3곳 (예: 1차 식사 → 2차 한잔). 밤 10시 이후면 한두 곳만, 늦게까지 하는 곳으로.
- 가게끼리 걸어서 10분 안쪽이면 좋다. 주소를 보고 판단해.
- 시간은 지금 바로라면 10~20분 뒤에 첫 곳에 도착한다고 보고, 다른 시간을 말했으면 그 시간부터. 한 곳에 1~2시간씩 잡아 "HH:MM"으로 적어.
- 마지막 답은 아래 JSON 하나만 출력해. 다른 말, 코드블록 표시(```)는 쓰지 마.
{"title": "코스 이름 (10자 안팎, 예: 쌀쌀한 밤 이자카야 코스)",
 "intro": "왜 이렇게 짰는지 한두 문장, 지금 날씨·시간을 자연스럽게 짚어서",
 "steps": [{"time": "23:20", "label": "1차", "id": "도구 결과의 id 그대로", "why": "이 가게를 고른 이유 한 문장"}],
 "tip": "방문 전 팁 한 문장 (예약·영업시간 확인 등)"}"""

WHO = {"couple": "연인과 데이트", "friends": "친구 몇 명", "solo": "혼자", "family": "가족·부모님", "team": "회식·단체"}
MOOD = {"cozy": "조용하고 아늑하게", "drink": "한잔하러", "hearty": "든든하게 배부르게", "light": "가볍게", "special": "특별한 날"}


def _parse_json(text: str) -> dict | None:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except ValueError:
        return None


async def plan(who: str, mood: str, note: str, center: dict | None) -> dict:
    if not GEMINI_KEY:
        raise UserError("no GEMINI_API_KEY", "AI 키가 설정되지 않았어요.", status=503)
    snap = await context.snapshot(center["lat"] if center else None, center["lng"] if center else None)
    system = SYSTEM_PROMPT + PLAN_PROMPT + "\n\n지금 상황\n" + context.describe(snap)
    if center:
        system += f"\n지도 위치: {center.get('label') or '알 수 없음'} (위도 {center['lat']}, 경도 {center['lng']})"
    ask = [f"누구와: {WHO.get(who, '정하지 않음')}", f"분위기: {MOOD.get(mood, '정하지 않음')}"]
    if note.strip():
        ask.append(f"메모: {note.strip()[:200]}")
    contents = [{"role": "user", "parts": [{"text": "\n".join(ask) + "\n이 조건으로 지금 갈 코스를 짜 줘."}]}]

    text, trace, session = await _run(contents, system, center)
    data = _parse_json(text) or {}
    steps = []
    for st in data.get("steps") or []:
        place = session.found.get(str(st.get("id")))
        if not place:
            continue  # 도구 결과에 없는 가게(지어낸 것)는 버린다
        steps.append({"time": str(st.get("time") or ""), "label": str(st.get("label") or ""),
                      "why": str(st.get("why") or ""), "place": place})
    if not steps:
        raise UserError(f"plan 실패: {text[:300]}", "코스를 짜지 못했어요. 조건을 바꿔서 다시 맡겨 주세요.")
    return {"title": str(data.get("title") or "오늘의 코스"), "intro": str(data.get("intro") or ""),
            "tip": str(data.get("tip") or ""), "steps": steps, "trace": trace}


def _mentioned(reply: str, found: dict[str, dict]) -> list[dict]:
    """답변에 이름이 나온 가게만, 나온 순서대로 (지도에 표시용)
    이름 앞뒤가 다른 글자로 이어지면 다른 낱말의 일부로 본다 (예: 가게 "소"가 "소주"에 걸리지 않게)"""
    hits = []
    for p in found.values():
        name = p["name"]
        m = re.search(rf"(?<![가-힣A-Za-z0-9]){re.escape(name)}(?![가-힣A-Za-z0-9])", reply)
        # 3글자 이상이면 "은주정은"처럼 조사가 붙은 경우도 인정
        at = m.start() if m else (reply.find(name) if len(name) >= 3 else -1)
        if at >= 0:
            hits.append((at, p))
    seen, out = set(), []
    for _, p in sorted(hits, key=lambda h: h[0]):
        if p["id"] not in seen:
            seen.add(p["id"])
            out.append(p)
    return out[:8]
