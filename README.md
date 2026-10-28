# 근처 맛집·술집 찾기

현재 위치(GPS)나 주소를 입력하면 반경 안의 **맛집·술집**을 지도와 목록으로 보여주는 웹앱입니다.

## 기능
- 📍 **내 위치** 버튼(브라우저 위치 권한) 또는 **주소/장소명 검색** (예: 강남역, 성수동)
- 지도를 클릭해서 기준 위치 바꾸기
- 맛집 / 술집 / 전체 탭(네트워크 재요청 없이 즉시 전환), 반경 300m ~ 2km
- 가까운 순 목록 ↔ 지도 마커 연동, 카카오맵·네이버지도·길찾기 링크
- 모바일 반응형

## 실행
Node.js 18 이상만 있으면 됩니다 (npm 패키지 설치 필요 없음).

```bash
cp .env.example .env     # 필요하면 키 입력
npm start                # http://localhost:3000
```

> 📍 위치 기능은 `localhost` 또는 HTTPS에서만 동작합니다 (브라우저 보안 정책).

## 데이터 소스
| 상황 | 사용 API | 비고 |
|---|---|---|
| `.env`에 `KAKAO_REST_API_KEY` 있음 | 카카오 로컬 API | **추천.** 국내 가게 데이터가 가장 풍부함. 검색당 최대 45곳 |
| 키 없음 | OpenStreetMap (Nominatim + Overpass) | 무료, 키 불필요. 국내는 등록된 가게가 적고, 공개 Overpass 서버가 서버발 요청을 자주 거절함 |

### 서버 최적화
- 같은 요청이 동시에 오면 외부 API는 한 번만 호출, 결과는 10분 캐시(실패는 캐시 안 함)
- 좌표를 약 10m 단위로 반올림해 캐시 적중률↑, 맛집·술집을 한 번에 받아 탭 전환 시 재요청 없음
- 카카오 2·3페이지 병렬 요청, Overpass는 마지막으로 성공한 미러부터 시도(미러당 12초)
- JSON·정적 파일 gzip 압축, 정적 파일 ETag(304)

카카오 키 발급: [developers.kakao.com](https://developers.kakao.com) → 내 애플리케이션 → 앱 생성 → **REST API 키** 복사
(제품 설정에서 "카카오맵" 사용 설정을 켜야 할 수 있습니다.)

평점/리뷰는 두 API 모두 제공하지 않아서, 각 가게의 **카카오맵/네이버지도 링크**로 확인하도록 했습니다.

## 디자인

현재 UI는 Pretendard + 종이색 배경의 단순한 목록/지도 레이아웃입니다. 아래는 이전 할로윈 버전의 Stitch 자료입니다.

### (이전) Google Stitch
- `design/stitch-halloween.html` — Stitch가 생성한 원본 디자인 HTML
- `design/stitch-render.png` — 원본 디자인 렌더링
- `design/stitch-prompt.json` — 생성에 사용한 프롬프트
- `scripts/stitch.js` — Stitch API(MCP) 호출 CLI. `.env`의 `STITCH_API_KEY` 사용

```bash
node scripts/stitch.js                                   # 사용 가능한 도구 목록
node scripts/stitch.js list_projects
node scripts/stitch.js edit_screens '{"projectId":"...","selectedScreenIds":["..."],"prompt":"..."}'
```


## 구조
```
server.js          # 정적 파일 + /api/geocode, /api/reverse, /api/places (API 키를 브라우저에 노출하지 않음)
public/index.html
public/style.css   # 디자인 토큰·레이아웃
public/app.js      # Leaflet 지도, 검색, 목록 렌더링
public/providers.js # 데이터 백엔드 선택: server.js → 카카오 JS SDK → OpenStreetMap
public/config.js   # 정적 배포용 설정 (카카오 JavaScript 키)
scripts/stitch.js  # Google Stitch API CLI
design/            # Stitch 결과물 & 스크린샷
```

## 무료 배포 ① GitHub Pages (서버 없이)
`main`에 push하면 `.github/workflows/pages.yml`이 `public/` 폴더를 자동 배포합니다.
→ https://da-hye0.github.io/test_web/

- 처음 한 번만: 저장소 **Settings → Pages → Source: GitHub Actions** 선택
- 서버가 없으므로 브라우저가 지도 API를 직접 호출합니다 (`public/providers.js`).
  - 기본: OpenStreetMap
  - 카카오 데이터를 쓰려면 `public/config.js`에 카카오 **JavaScript 키**를 넣고,
    카카오 developers → 플랫폼 → Web에 `https://da-hye0.github.io`를 등록하세요.

## 무료 배포 ② Render (Node 서버 그대로)
1. 이 폴더를 GitHub 저장소에 올립니다 (`.env`는 자동으로 제외됨).
2. [render.com](https://render.com)에 GitHub로 가입 → **New + → Blueprint** → 저장소 선택.
3. `KAKAO_REST_API_KEY` 입력(선택) → **Apply**. 몇 분 뒤 `https://matjip-finder-xxxx.onrender.com` 주소가 생깁니다.

무료 플랜은 15분 동안 접속이 없으면 잠들고, 다음 접속 때 깨어나는 데 30초~1분 정도 걸립니다.
