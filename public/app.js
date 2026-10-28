const $ = (sel) => document.querySelector(sel);

// 처음 들어왔을 때 바로 보여줄 위치 (서울 중구, 중구청 근처)
const START = { lat: 37.5638, lng: 126.9976, label: '서울 중구' };

const state = {
  center: null, // { lat, lng, label }
  type: 'all',
  radius: 500,
  all: [], // 반경 안의 맛집+술집 전체. 탭은 이걸 거르기만 한다
  provider: null,
  loading: false,
  routeMode: false, // 길찾기 카드가 떠 있는 동안: 가게를 고르면 그 가게로 경로를 다시 그린다
  routeTo: null, // 지금 경로의 목적지 id
  favorites: [], // 찜한 가게 (서버에 저장)
  favIds: new Set(),
};

// ---------- 지도 (map.js) ----------

// 지도는 화면 전체, 목록은 그 위에 떠 있다 (PC: 왼쪽 패널, 모바일: 아래 시트).
// 가려진 만큼을 빼고 보이는 영역의 가운데를 지도의 중심으로 본다
const MOBILE = matchMedia('(max-width: 760px)');
const sheet = { state: 'half', height: 0 }; // 모바일 시트: peek(검색만) / half / full

function mapInset() {
  if (MOBILE.matches) return { left: 0, top: $('#mobile-top').offsetHeight, bottom: sheet.height };
  return { left: document.body.classList.contains('panel-collapsed') ? 0 : $('.panel').offsetWidth, bottom: 0 };
}

const mapReady = createMap($('#map'), { inset: mapInset });
const markers = new Map(); // place.id → { el, focus() }

// 지도를 끌어 다른 곳으로 옮기면 "이 지역에서 다시 찾기" 버튼 (실수로 눌러도 검색이 바뀌지 않게)
const researchBtn = $('#research');

mapReady.then((m) => m.onUserMove((c) => {
  if (!state.center || state.type === 'fav') return;
  researchBtn.hidden = distanceMeters(state.center, c) < state.radius * 0.4;
}));

researchBtn.addEventListener('click', async () => {
  researchBtn.hidden = true;
  const c = (await mapReady).getCenter();
  setCenter(c.lat, c.lng, null);
});

$('#recenter').addEventListener('click', async () => (await mapReady).fitRadius());

// 목록 접기/펴기 — 지도 크기는 그대로, 보던 곳이 보이는 영역 가운데에 오도록 지도를 같이 민다
async function setPanel(open) {
  const before = mapInset().left;
  document.body.classList.toggle('panel-collapsed', !open);
  const tab = $('#panel-tab');
  tab.setAttribute('aria-expanded', open);
  tab.setAttribute('aria-label', open ? '목록 닫기' : '목록 열기');
  const map = await mapReady;
  map.panBy((before - mapInset().left) / 2);
  if (!roadviewWrap.hidden) setTimeout(() => map.roadview?.relayout(), 380);
}
$('#panel-tab').addEventListener('click', () => setPanel(document.body.classList.contains('panel-collapsed')));

// ---------- 모바일 바텀 시트 ----------
// 손잡이(또는 시트 윗부분)를 끌면 따라오고, 놓으면 가까운 높이(peek/half/full)로 붙는다.
// 빠르게 튕기면 그 방향의 다음 단계로.

const panel = $('.panel');

// 모바일 시트에는 목록만 있다: peek = 손잡이 + 결과 줄, full = 위쪽 검색창 바로 아래까지
function sheetHeights() {
  const vh = window.innerHeight;
  const top = $('#mobile-top').offsetHeight;
  return {
    peek: $('.sheet-handle').offsetHeight + $('.panel-meta').offsetHeight + 8,
    half: Math.round(vh * 0.45),
    full: vh - top - 8,
  };
}

// 모바일이면 검색창·필터·계정을 목록 밖(지도 위)으로, PC면 원래 자리로
const controls = {
  search: $('#search-form'),
  filters: $('.filters'),
  account: $('#account'),
};
const homes = {
  search: [controls.search.parentNode, controls.search.nextSibling],
  filters: [controls.filters.parentNode, controls.filters.nextSibling],
  account: [controls.account.parentNode, controls.account.nextSibling],
};

function placeControls() {
  if (MOBILE.matches) {
    $('#mobile-top').append(controls.search, controls.filters);
    $('.panel-meta').append(controls.account);
  } else {
    for (const key of Object.keys(controls)) {
      const [parent, next] = homes[key];
      parent.insertBefore(controls[key], next);
    }
  }
}

function applySheet(height) {
  sheet.height = height;
  document.body.style.setProperty('--sheet-h', `${height}px`);
}

async function setSheet(state) {
  if (!MOBILE.matches) return;
  const before = sheet.height;
  sheet.state = state;
  document.body.dataset.sheet = state;
  applySheet(sheetHeights()[state]);
  // 보던 곳이 보이는 영역 가운데에 그대로 있도록 지도도 같이 민다 (full은 지도가 거의 안 보여서 생략)
  if (before && state !== 'full') (await mapReady).panBy(0, (sheet.height - before) / 2);
}

let sheetDrag = null;

panel.addEventListener('pointerdown', (e) => {
  if (!MOBILE.matches) return;
  // 손잡이·제목줄에서만 끌기 시작 (입력창·버튼·목록 스크롤은 그대로)
  if (!e.target.closest('.sheet-handle, .panel-meta') || e.target.closest('button:not(.sheet-handle), input, a, select')) return;
  sheetDrag = { startY: e.clientY, startH: sheet.height, lastY: e.clientY, lastT: e.timeStamp, v: 0 };
  document.body.classList.add('sheet-dragging');
  panel.setPointerCapture(e.pointerId);
});

panel.addEventListener('pointermove', (e) => {
  if (!sheetDrag) return;
  const { full } = sheetHeights();
  const h = Math.max(80, Math.min(full, sheetDrag.startH + (sheetDrag.startY - e.clientY)));
  sheetDrag.v = (sheetDrag.lastY - e.clientY) / Math.max(1, e.timeStamp - sheetDrag.lastT); // 위로 + (px/ms)
  sheetDrag.lastY = e.clientY;
  sheetDrag.lastT = e.timeStamp;
  applySheet(h);
});

function endSheetDrag() {
  if (!sheetDrag) return;
  const { v, startH } = sheetDrag;
  sheetDrag = null;
  document.body.classList.remove('sheet-dragging');
  const heights = sheetHeights();
  const order = ['peek', 'half', 'full'];
  let target;
  if (Math.abs(v) > 0.5) {
    // 튕기기: 끌기 전 단계에서 한 단계 위/아래
    const i = order.indexOf(sheet.state);
    target = order[Math.max(0, Math.min(2, i + (v > 0 ? 1 : -1)))];
  } else {
    target = order.reduce((a, b) => (Math.abs(heights[b] - sheet.height) < Math.abs(heights[a] - sheet.height) ? b : a));
  }
  sheet.height = startH; // 지도 보정은 끌기 전 높이 기준
  setSheet(target);
}
panel.addEventListener('pointerup', endSheetDrag);
panel.addEventListener('pointercancel', endSheetDrag);

// 손잡이를 탭하면 접기 ↔ 펴기
$('.sheet-handle').addEventListener('click', () => {
  if (sheetDrag) return;
  setSheet(sheet.state === 'peek' ? 'half' : 'peek');
});

function initSheet() {
  placeControls();
  if (MOBILE.matches) {
    sheet.height = 0;
    setSheet(sheet.state);
  } else {
    document.body.style.removeProperty('--sheet-h');
    delete document.body.dataset.sheet;
  }
}
MOBILE.addEventListener('change', () => {
  initSheet();
  mapReady.then((m) => m.relayout());
});
// 화면 회전·주소창 접힘 등으로 크기가 바뀌면 시트 높이와 지도 크기를 다시 계산
window.addEventListener('resize', () => {
  if (MOBILE.matches) applySheet(sheetHeights()[sheet.state]);
  mapReady.then((m) => m.relayout());
});
initSheet();

// ---------- 로드뷰 (카카오맵일 때만) ----------

let hasRoadview = false;
mapReady.then((m) => { hasRoadview = Boolean(m.roadview); });

const roadviewWrap = $('#roadview-wrap');

async function openRoadview(place) {
  const map = await mapReady;
  if (!map.roadview || !place) return;
  $('#roadview-title').textContent = place.name;
  $('#roadview-empty').hidden = true;
  roadviewWrap.hidden = false;
  const found = await map.roadview.open($('#roadview'), place);
  $('#roadview-empty').hidden = found;
}

function closeRoadview() {
  roadviewWrap.hidden = true;
}

$('#roadview-close').addEventListener('click', closeRoadview);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !roadviewWrap.hidden) closeRoadview();
});

// ---------- 데이터 (providers.js) ----------

const backendReady = createBackend();

// ---------- 표시 ----------

function setStatus(html, isError = false) {
  const el = $('#status');
  el.innerHTML = html;
  el.classList.toggle('error', isError);
}

function setOrigin(label) {
  const el = $('#origin');
  el.hidden = !label;
  el.textContent = label || '';
}

const formatDistance = (m) => (m == null ? '' : m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${m}m`);

function distanceMeters(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(toRad(b.lat - a.lat) / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(toRad(b.lng - a.lng) / 2) ** 2;
  return Math.round(2 * 6371000 * Math.asin(Math.sqrt(h)));
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// ---------- 핵심 흐름 ----------

async function setCenter(lat, lng, label) {
  state.center = { lat, lng, label };
  researchBtn.hidden = true;
  setOrigin(label);

  (await mapReady).setMe(lat, lng);

  if (!label) {
    const center = state.center;
    backendReady
      .then((backend) => backend.reverse(lat, lng))
      .then((address) => {
        if (address && state.center === center) {
          center.label = address;
          setOrigin(address);
        }
      })
      .catch(() => {});
  }

  await loadPlaces();
}

async function loadPlaces() {
  const { center, radius } = state;
  if (!center) return;

  const map = await mapReady;
  if (state.type === 'fav') selectTab('all');
  if (state.routeMode) exitRouteMode();
  map.setRadius(center.lat, center.lng, radius);
  $('#recenter').hidden = false;

  state.loading = true;
  setStatus('찾는 중…');
  $('#list').innerHTML = '<li class="skeleton"></li>'.repeat(5);
  map.clearPlaces();
  markers.clear();

  try {
    const backend = await backendReady;
    const all = await backend.places(center.lat, center.lng, radius);
    // 응답이 늦게 오는 사이 다른 검색이 시작됐으면 무시
    if (state.center !== center || state.radius !== radius) return;
    state.all = all;
    state.provider = backend.provider;
    state.loading = false;
    render(map);
  } catch (e) {
    if (state.center !== center || state.radius !== radius) return;
    state.loading = false;
    $('#list').innerHTML = '';
    setStatus(escapeHtml(e.message), true);
  }
}

// 찜 탭: 기준 위치가 있으면 거리를 다시 계산해서 가까운 순, 없으면 최근에 찜한 순
function favoritePlaces() {
  const { center } = state;
  if (!center) return state.favorites.map((p) => ({ ...p, distance: null }));
  return state.favorites
    .map((p) => ({ ...p, distance: distanceMeters(center, p) }))
    .sort((a, b) => a.distance - b.distance);
}

function updateCounts() {
  const foodCount = state.all.filter((p) => p.kind === 'food').length;
  $('#count-all').textContent = state.center ? state.all.length : '';
  $('#count-food').textContent = state.center ? foodCount : '';
  $('#count-bar').textContent = state.center ? state.all.length - foodCount : '';
  $('#count-fav').textContent = state.favorites.length || '';
}

function render(map) {
  const isFav = state.type === 'fav';
  const places = isFav ? favoritePlaces()
    : state.type === 'all' ? state.all : state.all.filter((p) => p.kind === state.type);
  const label = { all: '맛집·술집', food: '맛집', bar: '술집', fav: '찜한 가게' }[state.type];

  updateCounts();
  setStatus(isFav
    ? `찜한 가게 <b>${places.length}곳</b>`
    : `반경 ${formatDistance(state.radius)} 안에 ${label} <b>${places.length}곳</b>`);
  $('#source').textContent = state.provider === 'kakao' ? '카카오 로컬 데이터' : 'OpenStreetMap 데이터';

  map.clearPlaces();
  markers.clear();
  state.byId = new Map(places.map((p) => [p.id, p]));

  const list = $('#list');
  if (!places.length) {
    list.innerHTML = isFav
      ? '<li class="empty">아직 찜한 가게가 없어요.<br>가게 오른쪽의 ♡를 눌러 저장해 보세요.</li>'
      : `<li class="empty">이 근처에서는 ${label}을 찾지 못했어요.<br>반경을 넓히거나 지도에서 다른 곳을 눌러 보세요.</li>`;
    return;
  }

  list.innerHTML = places.map((p, i) => {
    const { emoji, color } = placeStyle(p);
    const faved = state.favIds.has(p.id);
    return `
      <li class="row" data-id="${escapeHtml(p.id)}">
        <span class="icon" style="--c:${color}">${emoji}</span>
        <div class="row-body">
          <h3 class="name">${escapeHtml(p.name)}</h3>
          ${p.category ? `<div class="category">${escapeHtml(p.category.replace(/ > /g, ' · '))}</div>` : ''}
          ${p.address || p.phone ? `
            <div class="addr">${escapeHtml(p.address || '')}${p.phone ? `<span class="phone">${escapeHtml(p.phone)}</span>` : ''}</div>` : ''}
        </div>
        <div class="row-side">
          <span class="dist">${formatDistance(p.distance)}</span>
          <button type="button" class="fav${faved ? ' on' : ''}" data-action="fav" aria-pressed="${faved}" aria-label="찜하기">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.3 4.5 6.9 4.5c2.1 0 3.6 1.2 5.1 3 1.5-1.8 3-3 5.1-3 3.6 0 5.5 3.5 4.2 6.8-1.8 4.6-9.3 9.2-9.3 9.2z" /></svg>
          </button>
        </div>
        <div class="reviews">
          <div class="rv-inner">
            <div class="row-actions">
              <button type="button" class="route-btn${state.routeTo === p.id ? ' on' : ''}" data-action="route">${routeLabel(p.id)}</button>
              ${hasRoadview ? '<button type="button" class="roadview-btn" data-action="roadview">🛣️ 로드뷰</button>' : ''}
            </div>
            <div class="rv-content"></div>
            <button type="button" class="collapse-btn" data-action="collapse">접기</button>
          </div>
        </div>
      </li>`;
  }).join('');

  places.forEach((p, i) => {
    markers.set(p.id, map.addPlace(p, i + 1, {
      onSelect: () => selectPlace(p.id, { from: 'map' }),
      onRoute: () => startRoute(p.id),
    }));
  });
  if (isFav && !state.center) map.fitPoints(places.map((p) => [p.lat, p.lng]));
}

// 목록 안에서만 스크롤 (scrollIntoView는 바깥 화면까지 밀어 올려서 모바일 시트가 깨진다)
function scrollRowIntoList(row) {
  const list = $('#list');
  const top = row.offsetTop - list.offsetTop;
  const bottom = top + row.offsetHeight;
  if (top < list.scrollTop) list.scrollTo({ top: top - 8, behavior: 'smooth' });
  else if (bottom > list.scrollTop + list.clientHeight) {
    list.scrollTo({ top: Math.min(top - 8, bottom - list.clientHeight + 8), behavior: 'smooth' });
  }
}

function highlight(id, scrollList) {
  document.querySelectorAll('.row.active').forEach((el) => el.classList.remove('active'));
  markers.forEach((m, key) => key !== id && m.el.classList.contains('active') && m.setActive(false));
  document.querySelectorAll('.reviews.open').forEach((el) => el.classList.remove('open'));
  markers.get(id)?.setActive(true);
  const row = document.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
  if (!row) return;
  row.classList.add('active');
  openReviews(row.querySelector('.reviews'));
  loadReviews(row, state.byId?.get(id));
  if (scrollList) scrollRowIntoList(row);
}

// 펼친 가게 접기 (선택 해제)
function collapseRow(row) {
  row.classList.remove('active');
  row.querySelector('.reviews').classList.remove('open');
  markers.get(row.dataset.id)?.setActive(false);
}

// 가게 선택 (목록·핀 공통). 경로 모드면 그 가게로 경로를 다시 그리고, 아니면 지도를 그 가게로
function selectPlace(id, { from }) {
  if (from !== 'list' && MOBILE.matches && sheet.state === 'peek') setSheet('half');
  highlight(id, from === 'map');
  const place = state.byId?.get(id);
  if (state.routeMode && place) return showRoute(place);
  if (from === 'list') markers.get(id)?.focus();
  else markers.get(id)?.pan();
}

// ---------- 별점·후기 (가게를 눌렀을 때만 가져온다) ----------

const formatReviewDate = (d) => (d ? ` · ${escapeHtml(d)}` : '');
const stars = (n) => '★★★★★'.slice(0, Math.round(n)) + '☆☆☆☆☆'.slice(0, 5 - Math.round(n));

function googleHtml(g) {
  if (!g) return '<p class="rv-status">구글 지도에서 이 가게를 찾지 못했어요.</p>';
  const head = g.rating != null
    ? `<span class="g-score"><i>★</i>${g.rating.toFixed(1)}</span><span class="g-count">리뷰 ${g.count.toLocaleString()}개</span>`
    : '<span class="g-count">아직 별점이 없어요</span>';
  return `
    <div class="g-head">
      ${head}
      <a href="${escapeHtml(g.url)}" target="_blank" rel="noopener">구글 지도 ›</a>
    </div>
    ${g.reviews.length ? `<ul class="track">${g.reviews.map((r) => `
      <li class="card">
        <span class="g-stars" aria-label="별점 ${r.rating}점">${stars(r.rating)}</span>
        <p>${escapeHtml(r.text)}</p>
        <span class="rv-meta">${escapeHtml(r.author)}${formatReviewDate(r.when)}</span>
      </li>`).join('')}</ul>` : ''}`;
}

function blogHtml({ query, reviews }) {
  const moreUrl = `https://search.naver.com/search.naver?ssc=tab.blog.all&query=${encodeURIComponent(query)}`;
  return `
    ${reviews.length ? `<ul class="track">${reviews.map((r) => `
      <li class="card">
        <a href="${escapeHtml(r.link)}" target="_blank" rel="noopener">
          <strong>${escapeHtml(r.title)}</strong>
          <span class="rv-snippet">${escapeHtml(r.snippet)}</span>
          <span class="rv-meta">${escapeHtml(r.blogger)}${formatReviewDate(r.date)}</span>
        </a>
      </li>`).join('')}</ul>`
      : '<p class="rv-status">이 가게 이름이 들어간 후기를 찾지 못했어요.</p>'}
    <a class="rv-more" href="${escapeHtml(moreUrl)}" target="_blank" rel="noopener">네이버에서 더 보기 ›</a>`;
}

const failHtml = (e) => `<p class="rv-status error">${escapeHtml(e.message)}</p>`;

// 펼침은 CSS(grid-template-rows 0fr → 1fr)로 애니메이션, 다 펼쳐지면 가게가 보이도록 목록을 스크롤
const revealRow = (box) => setTimeout(() => {
  if (box.classList.contains('open')) scrollRowIntoList(box.closest('.row'));
}, 420);

function openReviews(box) {
  requestAnimationFrame(() => box.classList.add('open'));
  revealRow(box);
}

async function loadReviews(row, place) {
  const box = row.querySelector('.reviews');
  if (!box || !place || box.dataset.state) return; // 이미 불러왔거나 불러오는 중
  const backend = await backendReady;
  if (!backend.reviews && !backend.google) return;

  const inner = box.querySelector('.rv-content');
  box.dataset.state = 'loading';
  inner.innerHTML = '<p class="rv-status">후기를 찾는 중…</p>';

  // 구글 별점과 블로그 후기를 동시에 요청, 한쪽이 실패해도 다른 쪽은 보여준다
  const [google, blog] = await Promise.allSettled([
    backend.google?.(place.name, place.address, place.lat, place.lng),
    backend.reviews?.(place.name, place.address),
  ]);

  const sections = [];
  if (backend.google) {
    sections.push(`<p class="rv-head">구글 리뷰</p>${google.status === 'fulfilled' ? googleHtml(google.value) : failHtml(google.reason)}`);
    // 별점은 가게 이름 옆에도 표시
    if (google.value?.rating != null && !row.querySelector('.row-rating')) {
      row.querySelector('.name').insertAdjacentHTML('beforeend', ` <span class="row-rating">★ ${google.value.rating.toFixed(1)}</span>`);
    }
  }
  if (backend.reviews) {
    sections.push(`<p class="rv-head">블로그 후기</p>${blog.status === 'fulfilled' ? blogHtml(blog.value) : failHtml(blog.reason)}`);
  }
  inner.innerHTML = sections.map((html) => `<section>${html}</section>`).join('');
  revealRow(box); // 내용이 채워져 높이가 바뀌었으니 한 번 더

  if (google.status === 'rejected' || blog.status === 'rejected') delete box.dataset.state; // 다시 누르면 재시도
  else box.dataset.state = 'done';
}

// ---------- 가로 카드 드래그 ----------
// 터치는 브라우저 기본 스크롤, 마우스는 끌어서 넘긴다. 놓으면 scroll-snap이 카드에 맞춰 준다

let drag = null;

$('#list').addEventListener('pointerdown', (e) => {
  const track = e.target.closest('.track');
  if (!track || e.pointerType !== 'mouse' || e.button !== 0) return;
  drag = { track, startX: e.clientX, startLeft: track.scrollLeft, moved: false };
});

window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.startX;
  if (!drag.moved && Math.abs(dx) < 5) return;
  if (!drag.moved) {
    drag.moved = true;
    drag.track.classList.add('dragging');
  }
  drag.track.scrollLeft = drag.startLeft - dx;
});

window.addEventListener('pointerup', () => {
  if (!drag) return;
  const { track, moved } = drag;
  drag = null;
  if (!moved) return;
  track.classList.remove('dragging');
  // 끌고 난 직후의 클릭(링크 열림, 가게 선택)은 무시
  track.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); }, { capture: true, once: true });
});

// ---------- 찜 ----------

function setFavorites(list) {
  state.favorites = list;
  state.favIds = new Set(list.map((p) => p.id));
  updateCounts();
}

async function loadFavorites() {
  const backend = await backendReady;
  if (!backend.favorites) return;
  try {
    setFavorites(await backend.favorites.list());
  } catch {}
}

async function toggleFavorite(id, button) {
  const backend = await backendReady;
  const place = state.byId?.get(id);
  if (!backend.favorites || !place) return;
  const was = state.favIds.has(id);
  const prev = state.favorites;

  // 먼저 화면부터 바꾸고(낙관적 업데이트), 실패하면 되돌린다
  setFavorites(was ? prev.filter((p) => p.id !== id) : [{ ...place, savedAt: Date.now() }, ...prev]);
  button.classList.toggle('on', !was);
  button.setAttribute('aria-pressed', !was);
  if (!was) {
    button.classList.remove('pop');
    void button.offsetWidth; // 애니메이션 다시 시작
    button.classList.add('pop');
  }
  // 찜 탭에서 하트를 끄면 목록에서 바로 빠지게
  if (was && state.type === 'fav') mapReady.then(render);
  try {
    if (was) await backend.favorites.remove(id);
    else await backend.favorites.add(place);
  } catch (e) {
    setFavorites(prev);
    button.classList.toggle('on', was);
    button.setAttribute('aria-pressed', was);
    setStatus(escapeHtml(e.message), true);
  }
}

// ---------- 길찾기 ----------

let lastPosition = null; // { lat, lng, at }

function myPosition() {
  if (lastPosition && Date.now() - lastPosition.at < 60_000) return Promise.resolve(lastPosition);
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('이 브라우저는 위치 기능을 지원하지 않아요.'));
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        lastPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude, at: Date.now() };
        resolve(lastPosition);
      },
      (err) => reject(new Error(err.code === err.PERMISSION_DENIED ? '위치 권한이 꺼져 있어요.' : '현재 위치를 가져오지 못했어요.')),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  });
}

const routeCard = $('#route-card');

function hideRouteCard() {
  routeCard.hidden = true;
  routeCard.innerHTML = '';
}

function showRouteCard(html) {
  routeCard.innerHTML = `${html}<button type="button" class="route-close" aria-label="경로 닫기">✕</button>`;
  routeCard.hidden = false;
}

const routeLabel = (id) => (state.routeTo === id ? '🧭 경로 보는 중' : '🧭 길찾기');

function updateRouteButtons() {
  document.querySelectorAll('.route-btn').forEach((btn) => {
    const id = btn.closest('.row').dataset.id;
    btn.classList.toggle('on', state.routeTo === id);
    btn.textContent = routeLabel(id);
  });
}

// 길찾기 버튼 (목록 펼침 영역 / 핀 라벨): 경로 모드를 켜고 그 가게로
function startRoute(id) {
  state.routeMode = true;
  selectPlace(id, { from: 'route' });
}

async function exitRouteMode() {
  state.routeMode = false;
  state.routeTo = null;
  routeSeq++;
  hideRouteCard();
  updateRouteButtons();
  (await mapReady).clearRoute();
}

routeCard.addEventListener('click', (e) => {
  if (e.target.closest('.route-close')) exitRouteMode();
});

let routeSeq = 0; // 빠르게 여러 가게를 누를 때 늦게 온 이전 경로 응답은 버린다

async function showRoute(place) {
  const backend = await backendReady;
  if (!backend.route) return;
  const seq = ++routeSeq;
  state.routeTo = place.id;
  updateRouteButtons();
  showRouteCard(`<p class="route-title">${escapeHtml(place.name)}까지</p><p class="route-note">내 위치를 확인하는 중…</p>`);

  // 내 위치(GPS)에서 출발, 못 가져오면 검색한 기준 위치에서 출발
  let from;
  let fromLabel = '내 위치';
  try {
    from = await myPosition();
  } catch (e) {
    if (seq !== routeSeq) return;
    if (!state.center) return showRouteCard(`<p class="route-title">${escapeHtml(place.name)}까지</p><p class="route-note error">${escapeHtml(e.message)} 위치를 허용하거나 먼저 장소를 검색해 주세요.</p>`);
    from = state.center;
    fromLabel = '검색한 위치';
  }

  try {
    const r = await backend.route(from, place);
    if (seq !== routeSeq) return;
    (await mapReady).drawRoute(r.path);
    const kakaoNavi = `https://map.kakao.com/link/from/${encodeURIComponent(fromLabel)},${from.lat},${from.lng}/to/${encodeURIComponent(place.name)},${place.lat},${place.lng}`;
    showRouteCard(`
      <p class="route-title">${escapeHtml(place.name)}까지 <span>${formatDistance(r.distance)}</span></p>
      <div class="route-modes">
        <div><span class="route-emoji">🚶</span><b>${r.walkMin}분</b><small>도보 (예상)</small></div>
        <div><span class="route-emoji">🚗</span><b>${r.driveMin}분</b><small>자동차</small></div>
        ${r.taxi ? `<div><span class="route-emoji">🚕</span><b>${r.taxi.toLocaleString()}원</b><small>택시 예상</small></div>` : ''}
      </div>
      <p class="route-note">${escapeHtml(fromLabel)}에서 출발 · 지도 선은 자동차 경로예요</p>
      <a class="route-open" href="${escapeHtml(kakaoNavi)}" target="_blank" rel="noopener">카카오맵에서 안내 받기</a>`);
  } catch (e) {
    if (seq !== routeSeq) return;
    showRouteCard(`<p class="route-title">${escapeHtml(place.name)}까지</p><p class="route-note error">${escapeHtml(e.message)}</p>`);
  }
}

// ---------- 이벤트 ----------

$('#list').addEventListener('click', (e) => {
  if (e.target.closest('a')) return;
  const row = e.target.closest('.row');
  if (!row) return;
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'fav') return toggleFavorite(row.dataset.id, e.target.closest('.fav'));
  if (action === 'route') return startRoute(row.dataset.id);
  if (action === 'collapse') return collapseRow(row);
  if (action === 'roadview') return openRoadview(state.byId.get(row.dataset.id));
  if (row.classList.contains('active') && e.target.closest('.reviews')) return; // 펼친 리뷰 영역 안 클릭은 무시
  selectPlace(row.dataset.id, { from: 'list' });
});

const suggestions = $('#suggestions');

$('#search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#address').value.trim();
  if (!q) return;
  suggestions.hidden = true;
  setStatus('주소를 찾는 중…');
  try {
    const results = await (await backendReady).geocode(q);
    if (!results.length) return setStatus('그런 곳을 찾지 못했어요. 역 이름이나 동 이름으로 다시 검색해 보세요.', true);
    if (results.length === 1) return setCenter(results[0].lat, results[0].lng, results[0].name);
    // 후보가 여러 개면 고르게 함
    suggestions.innerHTML = results
      .map((r, i) => `<li data-i="${i}">${escapeHtml(r.name)}</li>`)
      .join('');
    suggestions.hidden = false;
    suggestions.onclick = (ev) => {
      const li = ev.target.closest('li');
      if (!li) return;
      const r = results[li.dataset.i];
      suggestions.hidden = true;
      setCenter(r.lat, r.lng, r.name);
    };
    setStatus('어느 곳인지 골라 주세요.');
  } catch (err) {
    setStatus(escapeHtml(err.message), true);
  }
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#search-form')) suggestions.hidden = true;
});

$('#locate').addEventListener('click', () => {
  if (!navigator.geolocation) return setStatus('이 브라우저는 위치 기능을 지원하지 않아요.', true);
  const btn = $('#locate');
  btn.disabled = true;
  setStatus('현재 위치를 확인하는 중…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btn.disabled = false;
      $('#address').value = '';
      setCenter(pos.coords.latitude, pos.coords.longitude, null);
    },
    (err) => {
      btn.disabled = false;
      const msg = err.code === err.PERMISSION_DENIED
        ? '위치 권한이 꺼져 있어요. 브라우저 설정에서 허용하거나 주소로 검색해 주세요.'
        : '현재 위치를 가져오지 못했어요. 주소로 검색해 주세요.';
      setStatus(msg, true);
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
  );
});

// 탭 전환은 받아둔 목록을 거르기만 한다 (네트워크 요청 없음)
function selectTab(type) {
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.type === type);
    t.setAttribute('aria-selected', t.dataset.type === type);
  });
  state.type = type;
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    selectTab(tab.dataset.type);
    if (state.type === 'fav' || (state.center && !state.loading)) mapReady.then(render);
  });
});

$('#radius').addEventListener('change', (e) => {
  state.radius = Number(e.target.value);
  loadPlaces();
});

// ---------- 로그인 (첫 화면) ----------

const gateStatus = $('#gate-status');

function lock(locked) {
  document.body.classList.toggle('locked', locked);
  if (locked) return;
  // 로그인 화면이 걷힌 뒤에야 시트 높이와 지도 크기를 잴 수 있다 (숨겨진 채 만든 지도는 크기가 0이라 잘려 보임)
  initSheet();
  mapReady.then((m) => m.relayout());
}

$('#logout').addEventListener('click', async () => {
  await fetch('auth/logout', { method: 'POST' }).catch(() => {});
  renderAccount(null);
  lock(true);
});

function renderAccount(user) {
  $('#profile').hidden = !user;
  if (!user) return;
  $('#profile-name').textContent = user.name;
  const img = $('#profile-image');
  img.hidden = !user.image;
  if (user.image) img.src = user.image;
}

// 서버(server.js)가 없으면(GitHub Pages) 로그인 없이 바로 쓴다
fetch('api/me', { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : Promise.reject()))
  .then(({ user, providers }) => {
    $('#gate').querySelectorAll('.sns').forEach((a) => { a.hidden = !providers.includes(a.dataset.provider); });
    if (!providers.length || user) {
      renderAccount(user);
      lock(false);
      if (user) loadFavorites();
      start();
    }
  })
  .catch(() => {
    lock(false);
    start();
  });

// 입장하면 바로 서울 중구 주변을 보여준다 (이미 다른 곳을 검색했으면 그대로)
function start() {
  if (!state.center) setCenter(START.lat, START.lng, START.label);
}

// 로그인 실패/취소 후 돌아왔을 때 안내
const loginResult = new URLSearchParams(location.search).get('login');
if (loginResult) {
  const msg = {
    cancelled: '로그인을 취소했어요.',
    expired: '로그인 시간이 지났어요. 다시 시도해 주세요.',
    unavailable: '아직 설정되지 않은 로그인 방식이에요.',
    failed: '로그인에 실패했어요. 잠시 후 다시 시도해 주세요.',
  }[loginResult];
  if (msg) {
    gateStatus.textContent = msg;
    gateStatus.hidden = false;
  }
  history.replaceState(null, '', location.pathname);
}
