# 지금 상황(시간·계절·날씨) → AI에게 넘기는 문장이 맞게 만들어지는지
from datetime import datetime

from app import context
from app.context import KST

COLD_RAIN = {"sky": "비", "kind": "rain", "temp": 4, "feels": 1, "min": 3, "max": 9,
             "rainChance": 80, "wind": 3.1, "dust": "나쁨"}


def snap(hour: int, weekday_day: int = 10, weather: dict | None = None) -> dict:
    """2026년 11월 10일(화) 기준, 원하는 시각의 상황"""
    now = datetime(2026, 11, weekday_day, hour, 5, tzinfo=KST)
    return {
        "now": now,
        "date": f"{now.year}년 {now.month}월 {now.day}일",
        "time": f"{context._time_of_day(hour)} {hour}시 05분",
        "season": context._season(now.month),
        "weekend": now.weekday() >= 5,
        "weather": weather,
        "tags": context.feel_tags(weather, now),
    }


def test_season_and_time_of_day():
    assert context._season(11) == "늦가을"
    assert context._season(1) == "한겨울"
    assert context._time_of_day(23) == "밤"
    assert context._time_of_day(12) == "점심"
    assert context._time_of_day(3) == "새벽"


def test_dust_grade_uses_worse_of_pm10_and_pm25():
    assert context._dust_grade(20, 10) == "좋음"
    assert context._dust_grade(20, 40) == "나쁨"
    assert context._dust_grade(None, None) is None


def test_feel_tags():
    tags = context.feel_tags(COLD_RAIN, datetime(2026, 11, 13, 22, 0, tzinfo=KST))  # 금요일 밤
    assert {"rain", "cold", "dust", "late", "weekend-night"} <= set(tags)
    assert context.feel_tags(None, datetime(2026, 11, 10, 12, 0, tzinfo=KST)) == []


def test_describe_late_night_warns_to_skip_closed_restaurants():
    text = context.describe(snap(23, weather=COLD_RAIN))
    assert "시간 주의" in text
    assert "양식·이탈리안" in text
    assert "체감 1°C" in text and "미세먼지 나쁨" in text


def test_describe_dinner_mentions_last_order():
    assert "라스트 오더" in context.describe(snap(20))


def test_describe_without_weather():
    text = context.describe(snap(12))
    assert "날씨: 정보를 가져오지 못했어요" in text
    assert "시간 주의" not in text


def test_describe_includes_tomorrow_forecast():
    weather = {**COLD_RAIN, "tomorrow": {"sky": "맑음", "min": 2, "max": 11, "rainChance": 10}}
    assert "내일 예보: 맑음, 최저 2°C / 최고 11°C, 강수확률 10%" in context.describe(snap(23, weather=weather))


def test_after_midnight_tomorrow_means_today():
    text = context.describe(snap(1, weather={**COLD_RAIN, "tomorrow": {"sky": "맑음", "min": 2, "max": 11, "rainChance": 10}}))
    assert "'내일'은 보통 오늘(11월 10일) 낮" in text
    assert "내일 예보" not in text


def test_late_night_warning_is_only_for_going_now():
    assert "시간 주의(지금 바로 갈 때만)" in context.describe(snap(23))


def test_describe_hides_missing_rain_chance():
    text = context.describe(snap(12, weather={**COLD_RAIN, "rainChance": None}))
    assert "강수확률" not in text


def test_met_symbol_mapping():
    assert context._met_sky("lightrain_night") == ("비", "rain")
    assert context._met_sky("clearsky_day") == ("맑음", "clear")
    assert context._met_sky("heavysnow") == ("눈", "snow")
