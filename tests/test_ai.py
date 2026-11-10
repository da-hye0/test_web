# AI 응답 후처리: 가게 이름 찾기, 코스 JSON 읽기, '뭉치가 한 일' 문장
from app import ai

FOUND = {
    "kakao-1": {"id": "kakao-1", "name": "소", "kind": "food"},
    "kakao-2": {"id": "kakao-2", "name": "스키마야", "kind": "bar"},
    "kakao-3": {"id": "kakao-3", "name": "만게츠 천호점", "kind": "bar"},
}


def test_mentioned_keeps_order_and_ignores_name_inside_other_words():
    reply = "1. 만게츠 천호점은 아늑하고, 2. 스키마야에서는 소주 한잔 하기 좋아요."
    names = [p["name"] for p in ai._mentioned(reply, FOUND)]
    assert names == ["만게츠 천호점", "스키마야"]  # "소주"의 "소"는 가게 "소"가 아니다


def test_parse_json_from_text_with_extra_words():
    data = ai._parse_json('코스예요 {"title": "밤 코스", "steps": []} 끝')
    assert data == {"title": "밤 코스", "steps": []}
    assert ai._parse_json("JSON이 없어요") is None


def test_trace_lines():
    session = ai.Session(None)
    session.found = dict(FOUND)
    search = ai._trace_line({"name": "search_places", "args": {"query": "천호 이자카야"}}, {"results": [1, 2, 3]}, session)
    reviews = ai._trace_line({"name": "get_reviews", "args": {"id": "kakao-2"}}, {}, session)
    assert search == "'천호 이자카야' 검색 · 3곳"
    assert reviews == "스키마야 후기 읽기"


def test_system_prompt_rules():
    assert "지금 바로 가는 거라면 지금 문 열었을 곳인지가 가장 먼저다" in ai.SYSTEM_PROMPT
    assert "내일 점심" in ai.SYSTEM_PROMPT  # 다른 시간을 말하면 그 시간 기준
    assert "지도 위치는 장소를 말하지 않았을 때만" in ai.SYSTEM_PROMPT
    assert "연인·남자친구" in ai.SYSTEM_PROMPT


def test_chat_answer_structured_picks():
    text = ('{"intro": "내일 점심, 천호역 근처로 골라봤어요.", '
            '"picks": [{"id": "kakao-2", "why": "조용해요"}, {"id": "없는-id", "why": "지어냄"}, {"id": "kakao-2", "why": "중복"}], '
            '"tip": "점심엔 웨이팅이 있어요."}')
    out = ai._chat_answer(text, FOUND)
    assert out["intro"] == "내일 점심, 천호역 근처로 골라봤어요."
    assert [p["place"]["name"] for p in out["picks"]] == ["스키마야"]  # 지어낸 id·중복은 버린다
    assert out["picks"][0]["why"] == "조용해요"
    assert [p["name"] for p in out["places"]] == ["스키마야"]
    assert "1. 스키마야 — 조용해요" in out["reply"] and out["reply"].endswith("점심엔 웨이팅이 있어요.")


def test_chat_answer_plain_text_fallback():
    out = ai._chat_answer("만게츠 천호점을 추천해요.", FOUND)
    assert out["picks"] == [] and out["intro"] == "만게츠 천호점을 추천해요."
    assert [p["name"] for p in out["places"]] == ["만게츠 천호점"]
