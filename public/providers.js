// 데이터 백엔드 선택
// 1) server.js 가 떠 있으면 서버 API 사용 (npm start)
// 2) 서버가 없고(GitHub Pages 등) config.js 에 카카오 JavaScript 키가 있으면 카카오 지도 SDK 사용
// 3) 둘 다 아니면 브라우저에서 OpenStreetMap 직접 호출
// 반환 형태는 server.js 의 /api/* 응답과 동일하다.

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const OSM_FOOD = ['restaurant', 'fast_food', 'food_court'];
const OSM_BAR = ['bar', 'pub', 'biergarten'];

function memoize(fn) {
  const cache = new Map();
  return (...args) => {
    const key = JSON.stringify(args);
    if (!cache.has(key)) cache.set(key, fn(...args).catch((e) => { cache.delete(key); throw e; }));
    return cache.get(key);
  };
}

async function fetchJson(url, options = {}, timeoutMs = 20000) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `요청 실패 (${res.status})`);
  return body;
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6371000 * Math.asin(Math.sqrt(a)));
}

// ---------- 1) server.js ----------

async function serverBackend() {
  const { provider, googleReviews } = await fetchJson('api/config', {}, 3000);
  const qs = (params) => new URLSearchParams(params);
  return {
    provider,
    geocode: async (q) => (await fetchJson(`api/geocode?${qs({ q })}`)).results,
    reverse: async (lat, lng) => (await fetchJson(`api/reverse?${qs({ lat, lng })}`)).address,
    // 서버가 Overpass 미러를 차례로 시도(각 12초)하므로 넉넉히 기다린다
    places: async (lat, lng, radius) => (await fetchJson(`api/places?${qs({ lat, lng, radius })}`, {}, 45000)).places,
    // 네이버 블로그 후기 — 서버에 키가 있어야 해서 서버 백엔드에서만 제공
    reviews: async (name, address) => fetchJson(`api/reviews?${qs({ name, address: address || '' })}`, {}, 15000),
    // 구글 별점·리뷰 — 서버에 GOOGLE_PLACES_API_KEY가 있을 때만
    google: googleReviews
      ? async (name, address, lat, lng) => (await fetchJson(`api/google?${qs({ name, address: address || '', lat, lng })}`, {}, 15000)).place
      : null,
    // 찜 (로그인 사용자별)
    favorites: {
      list: async () => (await fetchJson('api/favorites', { cache: 'no-store' })).favorites,
      add: async (place) => (await fetchJson('api/favorites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(place),
      })).favorite,
      remove: (id) => fetchJson(`api/favorites?${qs({ id })}`, { method: 'DELETE' }),
    },
    // 내 위치 → 가게 경로
    route: async (from, to) => fetchJson(`api/route?${qs({ fromLat: from.lat, fromLng: from.lng, toLat: to.lat, toLng: to.lng })}`),
  };
}

// ---------- 2) 카카오 지도 JavaScript SDK ----------

async function kakaoBackend(appKey) {
  await loadKakaoSdk(appKey); // map.js
  const { services, LatLng } = window.kakao.maps;
  const geocoder = new services.Geocoder();
  const ps = new services.Places();

  // 카카오 SDK 콜백 → Promise. 결과 없음은 빈 배열로.
  const call = (fn, ...args) => new Promise((resolve, reject) => {
    fn(...args, (data, status, pagination) => {
      if (status === services.Status.OK) resolve({ data, pagination });
      else if (status === services.Status.ZERO_RESULT) resolve({ data: [], pagination: null });
      else reject(new Error('카카오 지도 검색에 실패했습니다.'));
    });
  });

  // 한 검색당 최대 45개(15개 x 3페이지)
  async function allPages(fn, first, options) {
    const out = [];
    for (let page = 1; page <= 3; page++) {
      const { data, pagination } = await call(fn, first, { ...options, page });
      out.push(...data);
      if (!pagination?.hasNextPage) break;
    }
    return out;
  }

  return {
    provider: 'kakao',

    async geocode(q) {
      const addr = await call(geocoder.addressSearch.bind(geocoder), q);
      if (addr.data.length) {
        return addr.data.slice(0, 5).map((d) => ({ name: d.address_name, lat: Number(d.y), lng: Number(d.x) }));
      }
      const kw = await call(ps.keywordSearch.bind(ps), q, { size: 5 });
      return kw.data.map((d) => ({
        name: `${d.place_name} (${d.road_address_name || d.address_name})`,
        lat: Number(d.y),
        lng: Number(d.x),
      }));
    },

    async reverse(lat, lng) {
      const { data } = await call(geocoder.coord2Address.bind(geocoder), lng, lat);
      const d = data[0];
      return d ? (d.road_address?.address_name || d.address?.address_name) : null;
    },

    async places(lat, lng, radius) {
      const options = { location: new LatLng(lat, lng), radius, sort: services.SortBy.DISTANCE, size: 15 };
      const jobs = [
        allPages(ps.categorySearch.bind(ps), 'FD6', options),
        allPages(ps.keywordSearch.bind(ps), '술집', options),
      ];

      const seen = new Set();
      const places = [];
      for (const d of (await Promise.all(jobs)).flat()) {
        if (seen.has(d.id)) continue;
        seen.add(d.id);
        const categoryPath = d.category_name || '';
        if (categoryPath.includes('구내식당')) continue; // 일반 손님이 못 가는 곳
        const kind = categoryPath.includes('술집') ? 'bar' : 'food'; // 예: 음식점 > 술집 > 호프,요리주점
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
    },
  };
}

// ---------- 3) OpenStreetMap (브라우저 직접 호출) ----------

function osmBackend() {
  let mirrorIndex = 0; // 마지막으로 응답한 미러부터 시도
  return {
    provider: 'osm',

    async geocode(q) {
      const params = new URLSearchParams({ q, format: 'json', limit: 5, countrycodes: 'kr', 'accept-language': 'ko' });
      const data = await fetchJson(`https://nominatim.openstreetmap.org/search?${params}`);
      return data.map((d) => ({ name: d.display_name, lat: Number(d.lat), lng: Number(d.lon) }));
    },

    async reverse(lat, lng) {
      const params = new URLSearchParams({ lat, lon: lng, format: 'json', 'accept-language': 'ko', zoom: 18 });
      const data = await fetchJson(`https://nominatim.openstreetmap.org/reverse?${params}`);
      return data.display_name || null;
    },

    async places(lat, lng, radius) {
      const amenities = [...OSM_FOOD, ...OSM_BAR];
      const query = `[out:json][timeout:25];nwr["amenity"~"^(${amenities.join('|')})$"](around:${radius},${lat},${lng});out center tags 200;`;

      let data;
      let lastError;
      for (let i = 0; i < OVERPASS_MIRRORS.length; i++) {
        const index = (mirrorIndex + i) % OVERPASS_MIRRORS.length;
        try {
          data = await fetchJson(OVERPASS_MIRRORS[index], { method: 'POST', body: new URLSearchParams({ data: query }) }, 12000);
          mirrorIndex = index;
          break;
        } catch (e) {
          lastError = e;
        }
      }
      if (!data) throw new Error(`가게 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요. (${lastError?.message})`);

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
    },
  };
}

// ---------- 선택 ----------

async function createBackend() {
  let backend;
  try {
    backend = await serverBackend();
  } catch {
    const kakaoKey = (window.APP_CONFIG?.kakaoJsKey || '').trim();
    backend = kakaoKey ? await kakaoBackend(kakaoKey).catch((e) => {
      console.warn(e.message, '→ OpenStreetMap 사용');
      return osmBackend();
    }) : osmBackend();
  }
  // 좌표는 소수점 4자리(약 10m)로 맞춰서 캐시 적중률을 높인다
  const round = (n) => Number(n.toFixed(4));
  const reverse = memoize(backend.reverse);
  const allPlaces = memoize(backend.places);
  return {
    provider: backend.provider,
    geocode: memoize(backend.geocode),
    reviews: backend.reviews ? memoize(backend.reviews) : null,
    google: backend.google ? memoize(backend.google) : null,
    favorites: backend.favorites || null,
    route: backend.route || null,
    reverse: (lat, lng) => reverse(round(lat), round(lng)),
    // 맛집/술집은 한 번에 받아두고 종류 필터는 여기서 → 탭을 바꿔도 다시 요청하지 않는다
    places: async (lat, lng, radius, type = 'all') => {
      const all = await allPlaces(round(lat), round(lng), radius);
      return type === 'all' ? all : all.filter((p) => p.kind === type);
    },
  };
}
