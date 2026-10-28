// 맛집·술집 찾기 서버 (외부 의존성 없음, Node 18+)
// - 카카오 REST API 키가 있으면 카카오 로컬 API 사용
// - 없으면 OpenStreetMap(Nominatim + Overpass) 사용
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

loadEnv(path.join(__dirname, '.env'));
const auth = require('./auth'); // .env를 읽은 뒤에 불러와야 키가 잡힌다
const { favorites } = require('./store');

const PORT = Number(process.env.PORT) || 3000;
const KAKAO_KEY = (process.env.KAKAO_REST_API_KEY || '').trim();
// 카카오맵 JavaScript 키 — 브라우저에 공개되는 용도의 키라서 /api/config로 내려준다
const KAKAO_JS_KEY = (process.env.KAKAO_JS_KEY || '').trim();
// 로그인 기능이 켜져 있으면(키가 하나라도 있으면) 첫 화면은 로그인, API도 로그인한 사람만
const LOGIN_REQUIRED = auth.enabledProviders.length > 0;
const GOOGLE_PLACES_KEY = (process.env.GOOGLE_PLACES_API_KEY || '').trim();
const PUBLIC_DIR = path.join(__dirname, 'public');
const USER_AGENT = 'matjip-finder/1.0 (personal project)';
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// ---------- 유틸 ----------

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

// 같은 키로 동시에 들어온 요청은 외부 API를 한 번만 부르고, 실패는 캐시하지 않는다
function cached(key, fn, ttl = CACHE_TTL) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) {
    cache.delete(key); // 최근 사용 순서 갱신 (LRU)
    cache.set(key, hit);
    return hit.value;
  }
  const value = fn().catch((e) => {
    cache.delete(key);
    throw e;
  });
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}

async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} ${body.slice(0, 200)}`);
  }
  return res.json();
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

// ---------- 카카오 ----------

function kakaoSearch(target, params) {
  const url = `https://dapi.kakao.com/v2/search/${target}?${new URLSearchParams(params)}`;
  return fetchJson(url, { headers: { Authorization: `KakaoAK ${KAKAO_KEY}` } }, 8000);
}

function kakao(endpoint, params) {
  const url = `https://dapi.kakao.com/v2/local/${endpoint}?${new URLSearchParams(params)}`;
  return fetchJson(url, { headers: { Authorization: `KakaoAK ${KAKAO_KEY}` } });
}

async function kakaoGeocode(q) {
  const addr = await kakao('search/address.json', { query: q, size: 5 });
  const fromAddr = addr.documents.map((d) => ({
    name: d.address_name,
    lat: Number(d.y),
    lng: Number(d.x),
  }));
  if (fromAddr.length) return fromAddr;
  // "강남역", "홍대입구" 같은 장소명은 키워드 검색으로
  const kw = await kakao('search/keyword.json', { query: q, size: 5 });
  return kw.documents.map((d) => ({
    name: `${d.place_name} (${d.road_address_name || d.address_name})`,
    lat: Number(d.y),
    lng: Number(d.x),
  }));
}

async function kakaoReverse(lat, lng) {
  const data = await kakao('geo/coord2address.json', { x: lng, y: lat });
  const d = data.documents[0];
  return d ? (d.road_address?.address_name || d.address?.address_name) : null;
}

// 카카오는 한 검색당 최대 45개(15개 x 3페이지).
// 첫 페이지의 pageable_count로 남은 페이지 수를 알 수 있어서 2·3페이지는 동시에 요청한다.
async function kakaoAllPages(endpoint, params) {
  const first = await kakao(endpoint, { ...params, page: 1, size: 15 });
  if (first.meta.is_end) return first.documents;
  const lastPage = Math.min(3, Math.ceil(first.meta.pageable_count / 15));
  const rest = await Promise.all(
    Array.from({ length: lastPage - 1 }, (_, i) => kakao(endpoint, { ...params, page: i + 2, size: 15 })),
  );
  return [first, ...rest].flatMap((d) => d.documents);
}

async function kakaoPlaces(lat, lng, radius) {
  const base = { x: lng, y: lat, radius, sort: 'distance' };
  const jobs = [
    kakaoAllPages('search/category.json', { ...base, category_group_code: 'FD6' }),
    kakaoAllPages('search/keyword.json', { ...base, query: '술집' }),
  ];

  const seen = new Set();
  const places = [];
  for (const d of (await Promise.all(jobs)).flat()) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    const categoryPath = d.category_name || '';
    if (categoryPath.includes('구내식당')) continue; // 관공서·회사 구내식당은 일반 손님이 못 간다
    const isBar = categoryPath.includes('술집'); // 예: 음식점 > 술집 > 호프,요리주점
    const kind = isBar ? 'bar' : 'food';
    places.push({
      id: `kakao-${d.id}`,
      name: d.place_name,
      kind,
      category: categoryPath.split(' > ').slice(1).join(' > ') || categoryPath,
      address: d.road_address_name || d.address_name,
      phone: d.phone || null,
      lat: Number(d.y),
      lng: Number(d.x),
      distance: Number(d.distance),
      url: d.place_url,
    });
  }
  return places.sort((a, b) => a.distance - b.distance);
}

// ---------- OpenStreetMap ----------

async function osmGeocode(q) {
  const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({
    q, format: 'json', limit: 5, countrycodes: 'kr', 'accept-language': 'ko',
  })}`;
  const data = await fetchJson(url, { headers: { 'User-Agent': USER_AGENT } });
  return data.map((d) => ({ name: d.display_name, lat: Number(d.lat), lng: Number(d.lon) }));
}

async function osmReverse(lat, lng) {
  const url = `https://nominatim.openstreetmap.org/reverse?${new URLSearchParams({
    lat, lon: lng, format: 'json', 'accept-language': 'ko', zoom: 18,
  })}`;
  const data = await fetchJson(url, { headers: { 'User-Agent': USER_AGENT } });
  return data.display_name || null;
}

const OSM_FOOD = ['restaurant', 'fast_food', 'food_court'];
const OSM_BAR = ['bar', 'pub', 'biergarten'];

// 마지막으로 응답한 미러부터 시도해서, 죽은 미러 때문에 매번 기다리지 않게 한다
let overpassIndex = 0;
// 미러가 전부 실패하면 1분 동안은 다시 시도하지 않고 바로 실패 (매 검색마다 25초씩 기다리지 않게)
let overpassDownUntil = 0;

function overpassDownError(detail) {
  const err = new Error(`Overpass 실패: ${detail}`);
  err.userMessage = '무료 지도 데이터 서버가 응답하지 않아요. .env에 KAKAO_REST_API_KEY를 넣으면 빠르고 안정적으로 동작해요.';
  return err;
}

async function osmPlaces(lat, lng, radius) {
  if (Date.now() < overpassDownUntil) throw overpassDownError('최근 실패로 건너뜀');
  const amenities = [...OSM_FOOD, ...OSM_BAR];
  const query = `[out:json][timeout:25];nwr["amenity"~"^(${amenities.join('|')})$"](around:${radius},${lat},${lng});out center tags 200;`;

  let data;
  let lastError;
  for (let i = 0; i < OVERPASS_MIRRORS.length; i++) {
    const index = (overpassIndex + i) % OVERPASS_MIRRORS.length;
    try {
      data = await fetchJson(OVERPASS_MIRRORS[index], {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
        body: new URLSearchParams({ data: query }),
      }, 12000);
      overpassIndex = index;
      break;
    } catch (e) {
      lastError = e;
    }
  }
  if (!data) {
    // 공개 Overpass 서버는 서버에서 보내는 자동 요청을 자주 거절한다 → 카카오 키 사용 권장
    overpassDownUntil = Date.now() + 60 * 1000;
    throw overpassDownError(lastError?.message);
  }

  return data.elements
    .map((el) => {
      const t = el.tags || {};
      const pLat = el.lat ?? el.center?.lat;
      const pLng = el.lon ?? el.center?.lon;
      const name = t['name:ko'] || t.name;
      if (!name || pLat == null) return null;
      const address = [t['addr:city'], t['addr:district'], t['addr:street'], t['addr:housenumber']]
        .filter(Boolean).join(' ') || t['addr:full'] || null;
      return {
        id: `osm-${el.type}-${el.id}`,
        name,
        kind: OSM_BAR.includes(t.amenity) ? 'bar' : 'food',
        category: [t.amenity, t.cuisine].filter(Boolean).join(' · '),
        address,
        phone: t.phone || t['contact:phone'] || null,
        lat: pLat,
        lng: pLng,
        distance: distanceMeters(lat, lng, pLat, pLng),
        url: null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distance - b.distance);
}

// ---------- 블로그 후기 (카카오 다음 블로그 검색 — 네이버·티스토리 블로그 글도 함께 검색됨) ----------

const REVIEW_TTL = 6 * 60 * 60 * 1000;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };
const plainText = (html) => String(html || '')
  .replace(/<[^>]*>/g, '')
  .replace(/&(#?\w+);/g, (m, e) => ENTITIES[e] ?? (e.startsWith('#') ? String.fromCharCode(Number(e.slice(1))) : m))
  .trim();

const squash = (str) => str.replace(/\s+/g, '').toLowerCase();

// "능동미나리 을지로점" → "능동미나리". 다른 가게 글을 거를 때 쓴다
const coreName = (name) => name.replace(/\s*\S+점$/, '').trim() || name;

// "서울 중구 을지로 120" → "을지로" (동·도로명). 검색어를 동네로 좁히는 데 쓴다
function areaOf(address) {
  const parts = (address || '').split(/\s+/);
  return (parts[2] || parts[1] || '').replace(/\d.*$/, '');
}

async function blogReviews(name, address) {
  const core = coreName(name);
  const area = areaOf(address);
  const query = [name, name.includes(area) ? '' : area].filter(Boolean).join(' ');
  const data = await kakaoSearch('blog', { query, size: 20, sort: 'accuracy' });

  const reviews = data.documents
    .map((d) => ({
      title: plainText(d.title),
      snippet: plainText(d.contents),
      link: d.url,
      blogger: plainText(d.blogname),
      date: d.datetime ? d.datetime.slice(0, 10).replace(/-/g, '.') : null,
    }))
    // 제목이나 본문에 가게 이름이 실제로 있는 글만 (다른 가게 글 섞임 방지)
    .filter((r) => squash(r.title + r.snippet).includes(squash(core)))
    .slice(0, 5);

  return { query, total: data.meta.total_count, reviews };
}

// ---------- 구글 별점·리뷰 (Places API New) ----------
// 유료 API라서 가게를 눌렀을 때만 1회 호출한다.
// 구글 약관상 리뷰 내용은 오래 저장하지 않는다 → 같은 요청이 몰릴 때만 막는 짧은 캐시(10분)

const GOOGLE_FIELDS = [
  'places.displayName', 'places.location', 'places.rating', 'places.userRatingCount',
  'places.googleMapsUri', 'places.reviews',
].join(',');


async function googleRating(name, address, lat, lng) {
  const area = areaOf(address);
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_PLACES_KEY,
      'X-Goog-FieldMask': GOOGLE_FIELDS,
    },
    body: JSON.stringify({
      // 동네 이름을 붙여야 같은 이름의 먼 가게 대신 이 동네 가게가 잡힌다 (예: "키싸" → "키싸 을지로")
      textQuery: [name, name.includes(area) ? '' : area].filter(Boolean).join(' '),
      languageCode: 'ko',
      regionCode: 'KR',
      pageSize: 5,
      locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 200 } },
    }),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Google Places ${res.status} ${JSON.stringify(data.error || data).slice(0, 200)}`);
    if (res.status === 403) err.userMessage = '구글 Places API (New)가 켜져 있지 않거나 키 제한에 막혔어요.';
    throw err;
  }

  // 카카오 가게와 같은 곳인지
  // 1) 150m 안 + 이름이 서로 포함 관계
  // 2) 이름이 달라도(구글엔 "TABACCHI"처럼 영어로 등록된 곳이 많음) 30m 안이면 같은 가게로 본다
  const core = squash(coreName(name));
  const candidates = (data.places || [])
    .map((pl) => ({ pl, d: distanceMeters(lat, lng, pl.location.latitude, pl.location.longitude) }))
    .sort((a, b) => a.d - b.d);
  const sameName = ({ pl }) => {
    const g = squash(coreName(pl.displayName?.text || ''));
    return g && (g.includes(core) || core.includes(g));
  };
  const match = (candidates.find((c) => c.d <= 150 && sameName(c)) || candidates.find((c) => c.d <= 30))?.pl;
  if (!match) return null;

  return {
    rating: match.rating ?? null,
    count: match.userRatingCount ?? 0,
    url: match.googleMapsUri,
    reviews: (match.reviews || []).map((r) => ({
      rating: r.rating,
      text: (r.text?.text || r.originalText?.text || '').trim(),
      author: r.authorAttribution?.displayName || '구글 사용자',
      authorUrl: r.authorAttribution?.uri || null,
      when: r.relativePublishTimeDescription || '',
    })).filter((r) => r.text),
  };
}

// ---------- 길찾기 (카카오모빌리티 자동차 길찾기) ----------
// 걷기 경로 API는 공개된 것이 없어서, 자동차 경로를 그리고 도보 시간은 경로 거리로 추정한다 (분당 67m ≈ 시속 4km)

const WALK_M_PER_MIN = 67;

async function kakaoRoute(from, to) {
  const params = new URLSearchParams({
    origin: `${from.lng},${from.lat}`,
    destination: `${to.lng},${to.lat}`,
    priority: 'RECOMMEND',
  });
  const data = await fetchJson(`https://apis-navi.kakaomobility.com/v1/directions?${params}`, {
    headers: { Authorization: `KakaoAK ${KAKAO_KEY}` },
  }, 8000);
  const route = data.routes?.[0];
  if (!route || route.result_code !== 0) {
    // 출발지와 도착지가 너무 가까우면(약 5m 이내) 경로가 없다고 나온다
    const err = new Error(`route ${route?.result_code} ${route?.result_msg}`);
    err.userMessage = route?.result_msg || '경로를 찾지 못했어요.';
    throw err;
  }
  // vertexes는 [x1, y1, x2, y2, ...] → [[lat, lng], ...]
  const path = [];
  for (const section of route.sections) {
    for (const road of section.roads) {
      for (let i = 0; i < road.vertexes.length; i += 2) path.push([road.vertexes[i + 1], road.vertexes[i]]);
    }
  }
  const { distance, duration, fare } = route.summary;
  return {
    distance,
    driveMin: Math.max(1, Math.round(duration / 60)),
    walkMin: Math.max(1, Math.round(distance / WALK_M_PER_MIN)),
    taxi: fare?.taxi ?? null,
    path,
  };
}

function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      } catch {
        reject(Object.assign(new Error('bad json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// ---------- 라우팅 ----------

const provider = KAKAO_KEY ? 'kakao' : 'osm';
const api = {
  geocode: KAKAO_KEY ? kakaoGeocode : osmGeocode,
  reverse: KAKAO_KEY ? kakaoReverse : osmReverse,
  places: KAKAO_KEY ? kakaoPlaces : osmPlaces,
};

// 1KB 넘는 텍스트 응답은 gzip으로 보낸다 (가게 목록 JSON은 보통 10~20KB → 2~4KB)
function send(req, res, status, headers, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const compressible = /json|text|javascript|svg/.test(headers['Content-Type'] || '');
  if (compressible && buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    res.writeHead(status, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
    return res.end(zlib.gzipSync(buf));
  }
  res.writeHead(status, headers);
  res.end(buf);
}

function sendJsonRaw(req, res, status, body, maxAge = 0) {
  send(req, res, status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': status === 200 && maxAge ? `private, max-age=${maxAge}` : 'no-store',
  }, JSON.stringify(body));
}

// 소수점 4자리(약 10m)로 반올림해서, 거의 같은 위치의 요청이 캐시를 같이 쓰게 한다
function parseCoord(params) {
  const lat = Number(params.get('lat'));
  const lng = Number(params.get('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat: Number(lat.toFixed(4)), lng: Number(lng.toFixed(4)) };
}

async function handleApi(url, req, res) {
  const sendJson = (status, body, maxAge) => sendJsonRaw(req, res, status, body, maxAge);
  const p = url.searchParams;

  if (url.pathname === '/api/config') {
    return sendJson(200, { provider, kakaoJsKey: KAKAO_JS_KEY, googleReviews: Boolean(GOOGLE_PLACES_KEY), loginRequired: LOGIN_REQUIRED });
  }

  // 그 밖의 API는 로그인한 사람만 (유료 API 쿼터 보호)
  const user = auth.getUser(req);
  if (LOGIN_REQUIRED && !user) return sendJson(401, { error: '로그인이 필요해요.' });

  switch (url.pathname) {
    case '/api/favorites': {
      if (!user) return sendJson(401, { error: '로그인이 필요해요.' });
      const key = auth.userKey(user);
      if (req.method === 'GET') return sendJson(200, { favorites: await favorites.list(key) });
      if (req.method === 'POST') {
        const body = await readJson(req).catch((e) => e);
        if (body instanceof Error) return sendJson(body.status || 400, { error: '요청이 올바르지 않아요.' });
        return sendJson(200, { favorite: await favorites.add(key, body) });
      }
      if (req.method === 'DELETE') {
        await favorites.remove(key, p.get('id') || '');
        return sendJson(200, { ok: true });
      }
      return sendJson(405, { error: 'Method not allowed' });
    }

    case '/api/route': {
      if (!KAKAO_KEY) return sendJson(503, { error: '길찾기는 카카오 REST API 키가 있어야 해요.' });
      const from = parseCoord(new URLSearchParams({ lat: p.get('fromLat'), lng: p.get('fromLng') }));
      const to = parseCoord(new URLSearchParams({ lat: p.get('toLat'), lng: p.get('toLng') }));
      if (!from || !to) return sendJson(400, { error: '출발지와 도착지 좌표가 필요해요.' });
      const route = await cached(`route:${from.lat},${from.lng}>${to.lat},${to.lng}`, () => kakaoRoute(from, to));
      return sendJson(200, route, 300);
    }

    case '/api/geocode': {
      const q = (p.get('q') || '').trim();
      if (!q) return sendJson(400, { error: '주소를 입력해주세요.' });
      const results = await cached(`geo:${q}`, () => api.geocode(q));
      return sendJson(200, { results }, 3600);
    }

    case '/api/reverse': {
      const c = parseCoord(p);
      if (!c) return sendJson(400, { error: '좌표가 올바르지 않습니다.' });
      const address = await cached(`rev:${c.lat},${c.lng}`, () => api.reverse(c.lat, c.lng));
      return sendJson(200, { address }, 3600);
    }

    case '/api/places': {
      const c = parseCoord(p);
      if (!c) return sendJson(400, { error: '좌표가 올바르지 않습니다.' });
      const radius = Math.min(Math.max(Number(p.get('radius')) || 500, 100), 20000);
      const type = ['food', 'bar'].includes(p.get('type')) ? p.get('type') : 'all';
      // 맛집/술집은 항상 같이 받아서 캐시하고, 종류 필터는 캐시된 결과에서 거른다
      const all = await cached(`places:${c.lat},${c.lng},${radius}`, () => api.places(c.lat, c.lng, radius));
      const places = type === 'all' ? all : all.filter((x) => x.kind === type);
      return sendJson(200, { provider, places }, 300);
    }

    case '/api/reviews': {
      if (!KAKAO_KEY) return sendJson(503, { error: '블로그 후기는 카카오 REST API 키가 있어야 볼 수 있어요.' });
      const name = (p.get('name') || '').trim().slice(0, 60);
      const address = (p.get('address') || '').trim().slice(0, 120);
      if (!name) return sendJson(400, { error: '가게 이름이 필요해요.' });
      // 후기는 자주 바뀌지 않으니 일반 캐시(10분)보다 길게 둔다
      const result = await cached(`reviews:${name}|${areaOf(address)}`, () => blogReviews(name, address), REVIEW_TTL);
      return sendJson(200, result, 3600);
    }

    case '/api/google': {
      if (!GOOGLE_PLACES_KEY) return sendJson(503, { error: '구글 Places API 키가 설정되지 않았어요.' });
      const c = parseCoord(p);
      const name = (p.get('name') || '').trim().slice(0, 60);
      if (!c || !name) return sendJson(400, { error: '가게 이름과 좌표가 필요해요.' });
      const address = (p.get('address') || '').trim().slice(0, 120);
      const place = await cached(`google:${name}|${c.lat},${c.lng}`, () => googleRating(name, address, c.lat, c.lng));
      return sendJson(200, { place });
    }

    default:
      return sendJson(404, { error: 'Not found' });
  }
}

const MIME = {
  '.woff2': 'font/woff2',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(url, req, res) {
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.stat(file, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      res.writeHead(404);
      return res.end('Not found');
    }
    // 수정 시각 기반 ETag: 바뀌지 않은 파일은 304로 본문 없이 응답
    const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      return res.end();
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(500);
        return res.end();
      }
      send(req, res, 200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        ETag: etag,
      }, buf);
    });
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (await auth.handleAuth(url, req, res)) return;
    if (!url.pathname.startsWith('/api/')) return serveStatic(url, req, res);
    await handleApi(url, req, res);
  } catch (e) {
    console.error(`[${url.pathname}]`, e.message);
    sendJsonRaw(req, res, 502, { error: e.userMessage || '외부 지도 서비스 호출에 실패했습니다. 잠시 후 다시 시도해주세요.' });
  }
}).listen(PORT, () => {
  console.log(`🍻 맛집·술집 찾기: http://localhost:${PORT}`);
  console.log(`   로그인: ${auth.enabledProviders.join(', ') || '없음 (.env에 키를 넣으세요)'}`);
  console.log(`   데이터 소스: ${provider === 'kakao' ? '카카오 로컬 API' : 'OpenStreetMap (카카오 키를 .env에 넣으면 더 정확해집니다)'}`);
});
