// ===== 설정 =====
const DAYS_BACK = 5; // 오늘 포함, 5일 전 발매분까지 (scripts/fetch-releases.mjs의 값과 같게)
const DATA_URL = 'data/releases.json';
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const GENRE_ORDER = [
  '팝', '발라드', '힙합/랩', 'R&B/소울', '록/메탈', '인디/얼터너티브',
  '댄스/일렉트로닉', '재즈/블루스/클래식', '포크/컨트리/어쿠스틱', '트로트', 'OST/사운드트랙', '기타',
];
const TYPE_LABEL = { Album: '앨범', EP: 'EP', Single: '싱글' };
const REGIONS = [
  { key: 'domestic', title: '🇰🇷 국내' },
  { key: 'overseas', title: '🌍 해외' },
];

const state = { day: 'all', region: 'all', genre: 'all', type: 'all', q: '' };
let TODAY = '';
let ITEMS = [];

// ===== 도우미 =====
const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function kstToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function diffDays(later, earlier) {
  return Math.round((Date.parse(later + 'T00:00:00Z') - Date.parse(earlier + 'T00:00:00Z')) / 86400000);
}
function md(iso) {
  const [, m, d] = iso.split('-');
  return `${Number(m)}/${Number(d)}`;
}
function weekday(iso) {
  return WEEK[new Date(iso + 'T00:00:00Z').getUTCDay()];
}
function dayLabel(iso) {
  const n = diffDays(TODAY, iso);
  const head = n === 0 ? '오늘' : n === 1 ? '어제' : `${n}일 전`;
  return `${head} ${md(iso)}(${weekday(iso)})`;
}
const rank = (g) => {
  const i = GENRE_ORDER.indexOf(g);
  return i < 0 ? 99 : i;
};

function showNotice(msg) {
  const n = $('notice');
  n.textContent = msg;
  n.hidden = false;
}

// ===== 필터 =====
// skip: 칸별 개수를 셀 때 자기 자신의 필터는 빼고 계산합니다
function matches(it, skip) {
  if (skip !== 'day' && state.day !== 'all' && it.date !== state.day) return false;
  if (skip !== 'region' && state.region !== 'all' && it.region !== state.region) return false;
  if (skip !== 'genre' && state.genre !== 'all' && it.genre !== state.genre) return false;
  if (skip !== 'type' && state.type !== 'all' && it.type !== state.type) return false;
  if (state.q && !(it.artist + ' ' + it.title).toLowerCase().includes(state.q)) return false;
  return true;
}

function buildChips(boxId, key, field, options) {
  const box = $(boxId);
  box.replaceChildren();
  options.forEach(({ value, label }) => {
    const n = ITEMS.filter((it) => matches(it, key) && (value === 'all' || it[field] === value)).length;
    const b = el('button', 'chip' + (state[key] === value ? ' active' : ''));
    b.type = 'button';
    b.append(label + ' ', el('span', 'n', String(n)));
    b.addEventListener('click', () => {
      state[key] = value;
      update();
    });
    box.append(b);
  });
}

function renderControls() {
  const days = [{ value: 'all', label: `전체(${DAYS_BACK}일)` }];
  for (let n = 0; n <= DAYS_BACK; n++) {
    const iso = addDays(TODAY, -n);
    days.push({ value: iso, label: dayLabel(iso) });
  }
  buildChips('day-filter', 'day', 'date', days);

  buildChips('region-filter', 'region', 'region', [
    { value: 'all', label: '전체' },
    { value: 'domestic', label: '국내' },
    { value: 'overseas', label: '해외' },
  ]);

  const genres = [...new Set(ITEMS.map((it) => it.genre))].sort((a, b) => rank(a) - rank(b));
  buildChips('genre-filter', 'genre', 'genre', [
    { value: 'all', label: '전체' },
    ...genres.map((g) => ({ value: g, label: g })),
  ]);

  buildChips('type-filter', 'type', 'type', [
    { value: 'all', label: '전체' },
    { value: 'Album', label: '앨범' },
    { value: 'EP', label: 'EP' },
    { value: 'Single', label: '싱글' },
  ]);
}

// ===== 카드 =====
function card(it) {
  const q = encodeURIComponent(`${it.artist} ${it.title}`);
  const root = el('article', 'card');

  const cover = el('div', 'cover');
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = '';
  img.src = `https://coverartarchive.org/release-group/${it.id}/front-250`;
  img.addEventListener('error', () => img.remove()); // 커버가 없으면 기본 아이콘만 보입니다
  cover.append(img);

  const info = el('div', 'info');
  const badges = el('div', 'badges');
  badges.append(
    el('span', 'type', TYPE_LABEL[it.type] || it.type),
    el('span', 'date', `${md(it.date)}(${weekday(it.date)})`)
  );
  const title = el('h4', 'title', it.title);
  title.title = it.title;
  info.append(badges, title, el('p', 'artist', it.artist));
  if (it.tags && it.tags.length) {
    info.append(el('p', 'tags', it.tags.map((t) => '#' + t).join(' ')));
  }

  const links = el('div', 'links');
  const add = (label, href) => {
    const a = el('a', '', label);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    links.append(a);
  };
  add('YouTube', `https://www.youtube.com/results?search_query=${q}`);
  add('Spotify', `https://open.spotify.com/search/${q}`);
  if (it.region === 'domestic') add('Melon', `https://www.melon.com/search/total/index.htm?q=${q}`);
  add('MusicBrainz', `https://musicbrainz.org/release-group/${it.id}`);
  info.append(links);

  root.append(cover, info);
  return root;
}

// ===== 화면 =====
function groupByGenre(list) {
  const map = new Map();
  list.forEach((it) => {
    if (!map.has(it.genre)) map.set(it.genre, []);
    map.get(it.genre).push(it);
  });
  return [...map.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
}

function render() {
  const board = $('board');
  board.replaceChildren();
  if (ITEMS.length === 0) return;

  const visible = ITEMS.filter((it) => matches(it, null));
  if (visible.length === 0) {
    board.append(el('p', 'empty', '조건에 맞는 발매가 없습니다.'));
    return;
  }

  REGIONS.forEach(({ key, title }) => {
    if (state.region !== 'all' && state.region !== key) return;
    const list = visible.filter((it) => it.region === key);

    const sec = el('section', 'region');
    const h = el('h2', '', title);
    h.append(el('span', '', `${list.length}건`));
    sec.append(h);

    if (list.length === 0) sec.append(el('p', 'empty', '조건에 맞는 발매가 없습니다.'));

    groupByGenre(list).forEach(([genre, arr]) => {
      const det = el('details', 'genre');
      det.open = true;
      det.append(el('summary', '', `${genre} (${arr.length})`));
      const grid = el('div', 'grid');
      arr
        .sort((a, b) => b.date.localeCompare(a.date) || a.artist.localeCompare(b.artist))
        .forEach((it) => grid.append(card(it)));
      det.append(grid);
      sec.append(det);
    });
    board.append(sec);
  });
}

function update() {
  renderControls();
  render();
}

// ===== 불러오기 =====
function showMeta(json) {
  const from = addDays(TODAY, -DAYS_BACK);
  if (!json.generatedAt) {
    $('meta').textContent = `표시 범위 ${from} ~ ${TODAY}`;
    showNotice('아직 수집된 데이터가 없습니다. GitHub 저장소의 Actions 탭에서 update-releases를 한 번 실행해 주세요.');
    return;
  }
  const when = new Date(json.generatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
  $('meta').textContent = `마지막 업데이트 ${when} · 표시 범위 ${from} ~ ${TODAY} · 총 ${ITEMS.length}건`;
  if (Date.now() - Date.parse(json.generatedAt) > 36 * 3600 * 1000) {
    showNotice('데이터가 하루 넘게 갱신되지 않았습니다. Actions 탭에서 실행 상태를 확인해 주세요.');
  }
}

async function load() {
  TODAY = kstToday();
  try {
    const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    // 5일이 지난 항목과 미래 날짜 항목은 숨깁니다
    ITEMS = (json.items || []).filter((it) => {
      const n = diffDays(TODAY, it.date);
      return n >= 0 && n <= DAYS_BACK;
    });
    showMeta(json);
    update();
  } catch (e) {
    $('meta').textContent = '';
    showNotice('데이터를 불러오지 못했습니다. 파일을 직접 열지 말고 GitHub Pages 주소(또는 로컬 서버)로 열어 주세요. 그래도 안 되면 data/releases.json 파일이 있는지 확인해 주세요.');
  }
}

$('q').addEventListener('input', (e) => {
  state.q = e.target.value.trim().toLowerCase();
  update();
});

load();
