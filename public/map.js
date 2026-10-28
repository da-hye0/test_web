// 지도 어댑터
// - 카카오 JavaScript 키가 있으면 카카오맵, 없으면 Leaflet + OpenStreetMap
// - app.js는 아래 인터페이스만 쓴다
//     onUserMove(cb({ lat, lng }))          사용자가 지도를 끌어 옮겼을 때 (프로그램 이동은 제외)
//     getCenter() → { lat, lng }
//     panBy(dx, dy)                         지도 중심을 (dx, dy)px만큼 부드럽게 이동 (목록·시트 열고 닫을 때)
//     relayout()                            지도 영역 크기가 바뀐 뒤(로그인 화면이 걷힘, 화면 회전 등) 다시 계산
// createMap(el, { inset }) — inset()은 지도를 가리고 있는 UI 크기 { left, top, bottom }(px).
//   PC는 왼쪽 목록 폭, 모바일은 위 검색창·아래 시트 높이. 가게·경로·반경으로 이동할 때 보이는 영역의 가운데에 맞춘다
//     roadview: { open(container, place) → Promise<boolean> } | null   카카오맵에서만 (가게 근처 로드뷰가 있으면 true)
//     setMe(lat, lng)                       기준 위치 점
//     setRadius(lat, lng, meters)           반경 원 + 화면 맞춤
//     fitRadius()
//     clearPlaces()
//     addPlace(place, n, { onSelect, onRoute }) → { el, focus(), pan(), setActive(on) }
//     fitPoints([[lat, lng], ...])
//     drawRoute([[lat, lng], ...]) / clearRoute()

const DEFAULT_CENTER = [37.5638, 126.9976]; // 서울 중구 (app.js의 START와 같은 곳)
// 지도는 CSS 필터(invert + hue-rotate 180°)로 다크로 보이게 한다.
// 이 필터를 거치면 #3c8dff가 화면에서 토스 블루(#3182f6)로 보인다
const ROUTE_COLOR = '#3c8dff';
const RADIUS_STYLE = { color: ROUTE_COLOR, opacity: 0.9, weight: 1.5, fillOpacity: 0.08 };

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(new Error(`${src} 를 불러오지 못했습니다.`));
    document.head.appendChild(script);
  });
}

function loadCss(href) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

// 카카오 SDK는 지도와 장소 검색(providers.js)이 같이 쓰므로 한 번만 불러온다
let kakaoSdkPromise;
function loadKakaoSdk(appKey) {
  kakaoSdkPromise ||= loadScript(
    `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(appKey)}&libraries=services&autoload=false`,
  )
    .then(() => new Promise((resolve) => window.kakao.maps.load(resolve)))
    .catch(() => {
      kakaoSdkPromise = null;
      throw new Error('카카오 지도 SDK를 불러오지 못했습니다. JavaScript 키와 등록된 도메인을 확인하세요.');
    });
  return kakaoSdkPromise;
}

// 가게 종류별 아이콘(토스페이스 이모지)과 색 — 카카오 카테고리 경로("술집 > 와인바")를 보고 위에서부터 첫 번째로 맞는 것
const PLACE_STYLES = [
  // 술집
  [/와인/, '🍷', '#b06cf5'],
  [/칵테일|> 바$|> 바,/, '🍸', '#ec5c9b'],
  [/이자카야|일본식주점|사케/, '🏮', '#f0564a'],
  [/전통주|막걸리|민속주점/, '🍶', '#c9905a'],
  [/포장마차|포차|오뎅/, '🍢', '#f08a3c'],
  [/호프|맥주|비어|펍|pub|biergarten/, '🍺', '#f2a922'],
  [/술집|^bar/, '🍻', '#3182f6'],
  // 음식
  [/치킨|닭강정/, '🍗', '#f2a922'],
  [/피자|pizza/, '🍕', '#f08a3c'],
  [/햄버거|패스트푸드|fast_food|burger/, '🍔', '#e8a33a'],
  [/분식|떡볶이|김밥/, '🍙', '#f5c242'],
  [/육류|고기|삼겹|갈비|곱창|막창|족발|보쌈|bbq/, '🥩', '#f0564a'],
  [/> 회|횟집|해물|해산물|생선|조개|대게|장어|seafood/, '🦐', '#33b6e8'],
  [/초밥|스시|일식|돈까스|돈가스|우동|japanese|sushi/, '🍣', '#2bbfa4'],
  [/라멘|라면|국수|냉면|칼국수|noodle|ramen/, '🍜', '#e8c33a'],
  [/중식|중국|chinese/, '🥟', '#e5484d'],
  [/양식|이탈리|파스타|스테이크|italian|western|french/, '🍝', '#4cc38a'],
  [/베트남|태국|인도|아시아|멕시|vietnamese|thai|indian|asian|mexican/, '🍛', '#9bd14b'],
  [/제과|베이커리|디저트|간식|도넛|bakery|dessert/, '🥐', '#d4a373'],
  [/샐러드|샌드위치|salad|sandwich/, '🥗', '#5ec26a'],
  [/한식|찌개|국밥|해장국|탕|백반|korean/, '🍲', '#ff7a45'],
];

function placeStyle(place) {
  const text = `${place.kind === 'bar' ? '술집 ' : ''}${place.category || ''}`;
  const hit = PLACE_STYLES.find(([re]) => re.test(text));
  if (hit) return { emoji: hit[1], color: hit[2] };
  return place.kind === 'bar' ? { emoji: '🍻', color: '#3182f6' } : { emoji: '🍽️', color: '#8b95a1' };
}

// ---------- 경로 그리기 애니메이션 ----------
// 경로를 거리 기준으로 일정한 속도로, 끝으로 갈수록 천천히(ease-out) 늘려 그린다

const ROUTE_DRAW_MS = 1100;
const ROUTE_DELAY_MS = 250; // 지도 이동이 시작된 뒤에 그리기 시작

function cumulative(path) {
  const out = [0];
  for (let i = 1; i < path.length; i++) {
    const [lat1, lng1] = path[i - 1];
    const [lat2, lng2] = path[i];
    const dx = (lng2 - lng1) * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
    out.push(out[i - 1] + Math.hypot(lat2 - lat1, dx));
  }
  return out;
}

// draw(부분 경로)를 매 프레임 호출. 반환값은 취소 함수
function animatePath(path, draw) {
  const cum = cumulative(path);
  const total = cum[cum.length - 1] || 1;
  let raf = 0;
  const startAt = performance.now() + ROUTE_DELAY_MS;
  const frame = (now) => {
    const t = Math.max(0, Math.min(1, (now - startAt) / ROUTE_DRAW_MS));
    const target = (1 - (1 - t) ** 3) * total;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < target) i++;
    const [a, b] = [path[i - 1], path[i]];
    const k = cum[i] === cum[i - 1] ? 1 : Math.min(1, (target - cum[i - 1]) / (cum[i] - cum[i - 1]));
    draw([...path.slice(0, i), [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]]);
    if (t < 1) raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}

function meElement() {
  const el = document.createElement('div');
  el.className = 'me-pin';
  el.innerHTML = '<i></i>';
  return el;
}

// 말풍선 모양 핀: 종류 아이콘 + 아래 꼬리, 마우스를 올리거나 선택하면 가게 이름 라벨이 나온다
function placeElement(place) {
  const { emoji, color } = placeStyle(place);
  const el = document.createElement('div');
  el.className = 'pin';
  el.style.setProperty('--c', color);
  el.innerHTML = `<span class="pin-body"></span>
    <span class="pin-label"><span class="pin-name"></span><button type="button" class="pin-go" aria-label="길찾기" title="길찾기">🚶</button></span>`;
  el.querySelector('.pin-body').textContent = emoji;
  el.querySelector('.pin-name').textContent = place.name;
  return el;
}

// 선택한 핀은 다른 핀보다 위에
const BASE_Z = 5;
const ACTIVE_Z = 50;

// ---------- 카카오맵 ----------

async function kakaoMap(el, appKey, inset) {
  await loadKakaoSdk(appKey);
  const { maps } = window.kakao;
  const latLng = (lat, lng) => new maps.LatLng(lat, lng);

  el.classList.add('kakao');
  const map = new maps.Map(el, { center: latLng(...DEFAULT_CENTER), level: 4 });
  // 모바일은 손가락으로 확대하고, 오른쪽 아래는 시트가 가리므로 확대 버튼을 달지 않는다
  if (!matchMedia('(max-width: 760px)').matches) map.addControl(new maps.ZoomControl(), maps.ControlPosition.BOTTOMRIGHT);

  let me = null;
  let circle = null;
  let overlays = [];
  let route = [];
  let stopRouteAnim = () => {};

  const boundsOf = (points) => {
    const b = new maps.LatLngBounds();
    points.forEach(([lat, lng]) => b.extend(latLng(lat, lng)));
    return b;
  };

  // target이 목록에 가리지 않은 영역의 가운데에 오도록 하는 지도 중심
  function shifted(target) {
    const { left = 0, top = 0, bottom = 0 } = inset();
    if (!left && !top && !bottom) return target;
    const proj = map.getProjection();
    const p = proj.containerPointFromCoords(target);
    return proj.coordsFromContainerPoint(new maps.Point(p.x - left / 2, p.y + (bottom - top) / 2));
  }

  // 부드럽게 이동하되, 애니메이션이 중간에 끊기거나 막히는 환경(모션 줄이기 설정 등)에서도
  // 반드시 목표에 도착하도록 잠시 뒤 확인해서 못 갔으면 바로 옮긴다
  let moveTimer = 0;
  let settleTimer = 0;
  function panToSure(dest) {
    clearTimeout(settleTimer);
    map.panTo(dest);
    settleTimer = setTimeout(() => {
      const c = map.getCenter();
      if (Math.abs(c.getLat() - dest.getLat()) > 1e-6 || Math.abs(c.getLng() - dest.getLng()) > 1e-6) map.setCenter(dest);
    }, 700);
  }

  // 카카오맵은 줌과 이동을 한 번에 애니메이션하지 못해서, 줌 → 이동 순서로 나눠 부드럽게 옮긴다
  function smoothView(target, level, { exact = false } = {}) {
    clearTimeout(moveTimer);
    const zoom = level != null && level !== map.getLevel();
    if (zoom) map.setLevel(level, { animate: { duration: 280 } });
    moveTimer = setTimeout(() => {
      if (zoom && map.getLevel() !== level) map.setLevel(level); // 줌 애니메이션이 안 끝났으면 바로
      // 줌이 끝난 뒤의 축척으로 목록 폭만큼 보정 (exact면 이미 보정된 중심)
      panToSure(exact ? target : shifted(target));
    }, zoom ? 320 : 0);
  }

  // setBounds로 목표 위치·줌만 계산하고 원래대로 되돌린 뒤 smoothView로 이동. 왼쪽 여백에 목록 폭을 더한다
  function smoothBounds(bounds, top, right, bottom, left) {
    const from = { center: map.getCenter(), level: map.getLevel() };
    const { left: insetL = 0, top: insetT = 0, bottom: insetB = 0 } = inset();
    map.setBounds(bounds, top + insetT, right, bottom + insetB, left + insetL);
    const to = { center: map.getCenter(), level: map.getLevel() };
    map.setLevel(from.level);
    map.setCenter(from.center);
    smoothView(to.center, to.level, { exact: true });
  }

  // 로드뷰: 가게에서 가장 가까운 촬영 지점을 찾아 열고, 시선을 가게 쪽으로 돌린다
  let roadview = null;
  const roadviewClient = new maps.RoadviewClient();
  const nearestPano = (position, radius) => new Promise((resolve) => {
    roadviewClient.getNearestPanoId(position, radius, (panoId) => resolve(panoId));
  });

  return {
    provider: 'kakao',

    roadview: {
      async open(container, place) {
        const position = latLng(place.lat, place.lng);
        const panoId = (await nearestPano(position, 50)) || (await nearestPano(position, 150));
        if (!panoId) return false;
        roadview ||= new maps.Roadview(container);
        roadview.relayout();
        maps.event.addListener(roadview, 'init', function lookAtPlace() {
          maps.event.removeListener(roadview, 'init', lookAtPlace);
          const from = roadview.getPosition();
          // 촬영 지점 → 가게 방위각 (북쪽 0°, 시계 방향)
          const dLng = (place.lng - from.getLng()) * Math.cos(from.getLat() * Math.PI / 180);
          const dLat = place.lat - from.getLat();
          const pan = (Math.atan2(dLng, dLat) * 180 / Math.PI + 360) % 360;
          roadview.setViewpoint({ pan, tilt: 0, zoom: 0 });
        });
        roadview.setPanoId(panoId, position);
        return true;
      },
      relayout() {
        roadview?.relayout();
      },
    },

    onUserMove(cb) {
      maps.event.addListener(map, 'dragend', () => {
        const c = map.getCenter();
        cb({ lat: c.getLat(), lng: c.getLng() });
      });
    },

    getCenter() {
      const c = map.getCenter();
      return { lat: c.getLat(), lng: c.getLng() };
    },

    relayout() {
      const c = map.getCenter();
      map.relayout();
      map.setCenter(c);
    },

    // 지금 화면 가운데에서 (dx, dy)만큼 떨어진 지점이 새 중심이 되도록 부드럽게 이동
    panBy(dx = 0, dy = 0) {
      if (!dx && !dy) return;
      const proj = map.getProjection();
      const c = proj.containerPointFromCoords(map.getCenter());
      panToSure(proj.coordsFromContainerPoint(new maps.Point(c.x + dx, c.y + dy)));
    },

    setMe(lat, lng) {
      me?.setMap(null);
      me = new maps.CustomOverlay({ position: latLng(lat, lng), content: meElement(), zIndex: 4 });
      me.setMap(map);
    },

    setRadius(lat, lng, radius) {
      circle?.setMap(null);
      circle = new maps.Circle({
        center: latLng(lat, lng),
        radius,
        strokeWeight: RADIUS_STYLE.weight,
        strokeColor: RADIUS_STYLE.color,
        strokeOpacity: RADIUS_STYLE.opacity,
        strokeStyle: 'shortdash',
        fillColor: RADIUS_STYLE.color,
        fillOpacity: RADIUS_STYLE.fillOpacity,
      });
      circle.setMap(map);
      this.fitRadius();
    },

    fitRadius() {
      if (circle) smoothBounds(circle.getBounds(), 24, 24, 24, 24);
    },

    clearPlaces() {
      overlays.forEach((o) => o.setMap(null));
      overlays = [];
    },

    fitPoints(points) {
      if (points.length === 1) smoothView(latLng(...points[0]), 4);
      else if (points.length) smoothBounds(boundsOf(points), 60, 40, 60, 40);
    },

    drawRoute(path) {
      this.clearRoute();
      const line = new maps.Polyline({
        path: [latLng(...path[0])],
        strokeWeight: 6,
        strokeColor: ROUTE_COLOR,
        strokeOpacity: 0.95,
        strokeStyle: 'solid',
      });
      const start = new maps.CustomOverlay({ position: latLng(...path[0]), content: meElement(), zIndex: 6 });
      line.setMap(map);
      start.setMap(map);
      route = [line, start];
      // 경로 전체가 보이도록 부드럽게 이동하면서 선을 그린다 (아래쪽은 길찾기 카드 자리)
      smoothBounds(boundsOf(path), 80, 60, 220, 60);
      stopRouteAnim = animatePath(path, (part) => line.setPath(part.map(([lat, lng]) => latLng(lat, lng))));
    },

    clearRoute() {
      stopRouteAnim();
      route.forEach((o) => o.setMap(null));
      route = [];
    },

    addPlace(place, n, { onSelect, onRoute }) {
      const position = latLng(place.lat, place.lng);
      const pin = placeElement(place);
      // 번호가 작은(가까운) 가게가 위에 오도록
      const z = BASE_Z - n / 1000;
      const overlay = new maps.CustomOverlay({ position, content: pin, clickable: true, yAnchor: 1, zIndex: z });
      overlay.setMap(map);
      overlays.push(overlay);
      pin.addEventListener('click', (e) => {
        if (e.target.closest('.pin-go')) onRoute();
        else onSelect();
      });
      pin.addEventListener('mouseenter', () => overlay.setZIndex(ACTIVE_Z + 1));
      pin.addEventListener('mouseleave', () => overlay.setZIndex(pin.classList.contains('active') ? ACTIVE_Z : z));
      return {
        el: pin,
        // 너무 멀리 있으면 동네가 보이는 정도(레벨 4)까지만 들어가고, 이미 가까우면 이동만
        focus() {
          smoothView(position, map.getLevel() > 4 ? 4 : null);
        },
        pan() {
          panToSure(shifted(position));
        },
        setActive(on) {
          pin.classList.toggle('active', on);
          overlay.setZIndex(on ? ACTIVE_Z : z);
        },
      };
    },
  };
}

// ---------- Leaflet (OpenStreetMap) ----------

async function leafletMap(el, inset) {
  loadCss('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css');
  await loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js');
  el.classList.add('osm');

  const map = L.map(el, { zoomControl: false }).setView(DEFAULT_CENTER, 14);
  if (!matchMedia('(max-width: 760px)').matches) L.control.zoom({ position: 'bottomright' }).addTo(map);
  // 키 없이 쓸 수 있는 OSM 기본 타일. 색은 CSS(.map.osm .leaflet-tile-pane)에서 차분하게 눌러준다
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  // target이 목록에 가리지 않은 영역의 가운데에 오도록 하는 지도 중심
  const shifted = (target, zoom = map.getZoom()) => {
    const { left = 0, top = 0, bottom = 0 } = inset();
    return left || top || bottom ? map.unproject(map.project(target, zoom).subtract([left / 2, (top - bottom) / 2]), zoom) : target;
  };
  const pad = (top, right, bottom, left) => {
    const { left: l = 0, top: t = 0, bottom: b = 0 } = inset();
    return { paddingTopLeft: [left + l, top + t], paddingBottomRight: [right, bottom + b] };
  };

  const placeLayer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  let stopRouteAnim = () => {};
  let me = null;
  let circle = null;

  // 핀 크기는 CSS가 정하고, 꼬리 끝(가로 가운데·맨 아래)이 좌표를 가리키게 한다
  const divIcon = (el, anchorBottom) => L.divIcon({
    className: anchorBottom ? 'pin-anchor' : 'me-anchor',
    html: el,
    iconSize: [0, 0],
  });

  return {
    provider: 'osm',
    roadview: null,

    onUserMove(cb) {
      map.on('dragend', () => cb(this.getCenter()));
    },

    getCenter() {
      const c = map.getCenter();
      return { lat: c.lat, lng: c.lng };
    },

    relayout() {
      map.invalidateSize({ pan: false });
    },

    panBy(dx = 0, dy = 0) {
      if (dx || dy) map.panBy([dx, dy]);
    },

    setMe(lat, lng) {
      me?.remove();
      me = L.marker([lat, lng], { icon: divIcon(meElement(), false), interactive: false }).addTo(map);
    },

    setRadius(lat, lng, radius) {
      circle?.remove();
      circle = L.circle([lat, lng], {
        radius,
        color: RADIUS_STYLE.color,
        weight: RADIUS_STYLE.weight,
        opacity: RADIUS_STYLE.opacity,
        dashArray: '4 5',
        fillColor: RADIUS_STYLE.color,
        fillOpacity: RADIUS_STYLE.fillOpacity,
        interactive: false,
      }).addTo(map);
      this.fitRadius();
    },

    fitRadius() {
      if (circle) map.flyToBounds(circle.getBounds(), { ...pad(24, 24, 24, 24), duration: 0.6 });
    },

    clearPlaces() {
      placeLayer.clearLayers();
    },

    fitPoints(points) {
      if (points.length === 1) map.flyTo(shifted(L.latLng(points[0]), 17), 17, { duration: 0.6 });
      else if (points.length) map.flyToBounds(points, { ...pad(40, 40, 40, 40), duration: 0.6 });
    },

    drawRoute(path) {
      this.clearRoute();
      const line = L.polyline([path[0]], { color: ROUTE_COLOR, weight: 6, opacity: 0.95 }).addTo(routeLayer);
      L.marker(path[0], { icon: divIcon(meElement(), false), interactive: false }).addTo(routeLayer);
      map.flyToBounds(path, { ...pad(40, 40, 220, 40), duration: 0.8 });
      stopRouteAnim = animatePath(path, (part) => line.setLatLngs(part));
    },

    clearRoute() {
      stopRouteAnim();
      routeLayer.clearLayers();
    },

    addPlace(place, n, { onSelect, onRoute }) {
      const pin = placeElement(place);
      const marker = L.marker([place.lat, place.lng], { icon: divIcon(pin, true), zIndexOffset: -n })
        .on('click', (e) => {
          if (e.originalEvent?.target.closest('.pin-go')) onRoute();
          else onSelect();
        })
        .addTo(placeLayer);
      return {
        el: pin,
        focus() {
          const zoom = Math.max(map.getZoom(), 16);
          map.flyTo(shifted(marker.getLatLng(), zoom), zoom, { duration: 0.5 });
        },
        pan() {
          map.panTo(shifted(marker.getLatLng()));
        },
        setActive(on) {
          pin.classList.toggle('active', on);
          marker.setZIndexOffset(on ? 1000 : -n);
        },
      };
    },
  };
}

// ---------- 선택 ----------

async function appConfig() {
  const server = await fetch('api/config', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  return { kakaoJsKey: (server.kakaoJsKey || window.APP_CONFIG?.kakaoJsKey || '').trim() };
}

async function createMap(el, { inset = () => ({ left: 0, bottom: 0 }) } = {}) {
  const { kakaoJsKey } = await appConfig();
  if (kakaoJsKey) {
    try {
      return await kakaoMap(el, kakaoJsKey, inset);
    } catch (e) {
      console.warn(e.message, '→ OpenStreetMap 지도 사용');
    }
  }
  return leafletMap(el, inset);
}
