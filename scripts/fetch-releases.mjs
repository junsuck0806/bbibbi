// 최근 N일 안에 발매된 앨범/EP/싱글을 MusicBrainz에서 모아 data/releases.json 으로 저장합니다.
// 실행: node scripts/fetch-releases.mjs  (Node 18 이상, 따로 설치할 것 없음)
import { readFile, writeFile, mkdir } from 'node:fs/promises';

// ===== 설정 =====
// MusicBrainz는 연락처가 들어간 User-Agent를 요구합니다. 영문으로, 본인 저장소 주소로 바꾸세요.
const CONTACT = 'https://github.com/junsuck0806/bbibbi';
const USER_AGENT = `new-music-board/1.0 ( ${CONTACT} )`;

const DAYS_BACK = 1;              // 오늘 포함, 5일 전 발매분까지 (app.js의 값과 같게)
const PAGE_SIZE = 100;
const MAX_PAGES = 40;             // 안전장치: 최대 4,000건
const MAX_ARTIST_LOOKUPS = 1200;  // 한 번 실행에서 새로 조회할 아티스트 수 상한
const GAP_MS = 1100;              // 초당 1회 제한을 지키기 위한 호출 간격
const CACHE_KEEP_DAYS = 60;
const KEEP_PRIMARY = new Set(['Album', 'EP', 'Single']);
const EXCLUDE_SECONDARY = new Set(['Compilation', 'DJ-mix', 'Audiobook', 'Spokenword', 'Interview', 'Audio drama']);

// 아티스트의 장르/태그 이름을 아래 장르로 묶습니다. 위에 있는 규칙이 먼저 적용됩니다.
const GENRE_RULES = [
  { name: '힙합/랩', re: /hip.?hop|\brap\b|trap|drill|boom bap/i },
  { name: 'R&B/소울', re: /r&b|rnb|rhythm and blues|soul|funk/i },
  { name: '록/메탈', re: /rock|metal|punk|hardcore|grunge|\bemo\b/i },
  { name: '인디/얼터너티브', re: /indie|alternative|shoegaze|lo-?fi|bedroom|dream pop/i },
  { name: '댄스/일렉트로닉', re: /electro|edm|house|techno|trance|dance|dubstep|drum and bass|synth|disco|ambient|future bass/i },
  { name: '재즈/블루스/클래식', re: /jazz|blues|classical|orchestra|opera|baroque|symphon/i },
  { name: '포크/컨트리/어쿠스틱', re: /folk|country|bluegrass|acoustic|singer-songwriter|americana/i },
  { name: '트로트', re: /trot|트로트/i },
  { name: '발라드', re: /ballad|발라드/i },
  { name: '팝', re: /pop/i },
];
const KOREAN_TAG = /korea|k-pop|k-rap|k-indie|k-rock|k-ballad|trot/i;
const HANGUL = /[가-힣]/;

// ===== 도우미 =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function kstDate(offsetDays = 0) {
  const t = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(t);
}
const TODAY = kstDate(0);

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

let lastCall = 0;
async function mb(path, params) {
  const url = `https://musicbrainz.org/ws/2/${path}?` + new URLSearchParams({ ...params, fmt: 'json' });
  for (let attempt = 1; attempt <= 5; attempt++) {
    const wait = GAP_MS - (Date.now() - lastCall);
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
      if (res.ok) return await res.json();
      if (res.status === 404) return null;
      if (res.status === 429 || res.status === 503) {
        await sleep(5000 * attempt);
        continue;
      }
      const err = new Error(`HTTP ${res.status}: ${url}`);
      err.fatal = true;
      throw err;
    } catch (e) {
      if (e.fatal || attempt === 5) throw e;
      await sleep(3000 * attempt);
    }
  }
  throw new Error('재시도 횟수를 넘었습니다: ' + url);
}

// ===== 1) 기간 안에 발매된 앨범/EP/싱글 목록 =====
async function fetchReleaseGroups(from, to) {
  const types = ['album', 'single', 'ep'];
  const all = [];
  const seen = new Set();
  const start = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);

  for (const day = new Date(start); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
    const date = day.toISOString().slice(0, 10);

    for (const type of types) {
      const query = `firstreleasedate:${date} AND primarytype:${type}`;
      let offset = 0;
      let total = Infinity;

      // MusicBrainz search 결과는 검색당 최대 500건까지만 조회합니다.
      while (offset < total && offset < 500) {
        const data = await mb('release-group', { query, limit: PAGE_SIZE, offset });
        if (!data) break;

        total = data.count ?? 0;
        const list = data['release-groups'] || [];
        if (list.length === 0) break;

        for (const group of list) {
          if (!seen.has(group.id)) {
            seen.add(group.id);
            all.push(group);
          }
        }

        offset += list.length;
        console.log(`  ${date} ${type}: ${Math.min(offset, total)}/${total}`);
      }

      if (total > 500) {
        console.warn(`${date} ${type}: 검색 결과 ${total}건 중 앞의 500건만 가져왔습니다.`);
      }
    }
  }

  return all;
}

// ===== 2) 아티스트 정보(국가, 장르) =====
async function lookupArtist(id) {
  const a = await mb(`artist/${id}`, { inc: 'genres tags' });
  const slim = (arr) =>
    (arr || [])
      .slice()
      .sort((x, y) => (y.count || 0) - (x.count || 0))
      .slice(0, 8)
      .map((x) => ({ name: x.name, count: x.count || 0 }));
  if (!a) return { country: null, genres: [], tags: [], seen: TODAY };
  return {
    country: a.country || a.area?.['iso-3166-1-codes']?.[0] || null,
    genres: slim(a.genres),
    tags: slim(a.tags),
    seen: TODAY,
  };
}

// ===== 3) 장르 / 국내·해외 판별 =====
function genreOf(info, secondary) {
  if (secondary.includes('Soundtrack')) return 'OST/사운드트랙';
  const src = info?.genres?.length ? info.genres : info?.tags || [];
  const score = new Map();
  for (const t of src) {
    const rule = GENRE_RULES.find((r) => r.re.test(t.name));
    if (!rule) continue;
    score.set(rule.name, (score.get(rule.name) || 0) + Math.max(t.count || 1, 1));
  }
  if (score.size === 0) return '기타';
  return [...score.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function regionOf(info, artistName, title) {
  if (info?.country === 'KR') return 'domestic';
  const names = [...(info?.tags || []), ...(info?.genres || [])].map((t) => t.name);
  if (names.some((n) => KOREAN_TAG.test(n))) return 'domestic';
  if (!info?.country && (HANGUL.test(artistName) || HANGUL.test(title))) return 'domestic';
  return 'overseas';
}

// ===== 실행 =====
async function main() {
  const from = kstDate(-DAYS_BACK);
  const to = TODAY;
  console.log(`조회 기간: ${from} ~ ${to}`);

  const groups = await fetchReleaseGroups(from, to);
  console.log(`검색 결과 ${groups.length}건`);
  if (groups.length === 0) {
    throw new Error('검색 결과가 0건입니다. 검색식이나 네트워크를 확인하세요. (기존 데이터는 그대로 둡니다)');
  }

  // 정리: 중복, 기간 밖, 제외 종류, 아티스트 없음 걸러내기
  const rows = [];
  const seenIds = new Set();
  for (const g of groups) {
    if (seenIds.has(g.id)) continue;
    seenIds.add(g.id);
    const date = g['first-release-date'] || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < from || date > to) continue;
    if (!KEEP_PRIMARY.has(g['primary-type'])) continue;
    const secondary = g['secondary-types'] || [];
    if (secondary.some((t) => EXCLUDE_SECONDARY.has(t))) continue;
    const credits = g['artist-credit'] || [];
    const first = credits[0]?.artist;
    const artistName = credits.map((c) => (c.name || c.artist?.name || '') + (c.joinphrase || '')).join('').trim();
    if (!first?.id || !artistName || artistName === 'Various Artists' || /^\[.*\]$/.test(artistName)) continue;
    rows.push({ g, date, secondary, artistId: first.id, artistName });
  }
  console.log(`정리 후 ${rows.length}건`);

  // 아티스트 정보 (캐시에 없는 사람만 조회)
  await mkdir('data', { recursive: true });
  const cache = await readJson('data/artist-cache.json', {});
  const ids = [...new Set(rows.map((r) => r.artistId))];
  let lookups = 0;
  let failed = 0;
  for (const id of ids) {
    if (cache[id]) {
      cache[id].seen = TODAY;
      continue;
    }
    if (lookups >= MAX_ARTIST_LOOKUPS) continue;
    lookups++;
    try {
      cache[id] = await lookupArtist(id);
    } catch (e) {
      failed++;
      console.warn('아티스트 조회 실패', id, e.message);
    }
    if (lookups % 100 === 0) console.log(`  아티스트 조회 ${lookups}명 완료`);
  }
  const pending = ids.filter((id) => !cache[id]).length;
  console.log(`아티스트 ${ids.length}명 / 새로 조회 ${lookups}명 / 실패 ${failed}명 / 다음 실행으로 넘김 ${pending}명`);

  // 결과 만들기
  const items = rows.map(({ g, date, secondary, artistId, artistName }) => {
    const info = cache[artistId];
    const src = info ? (info.genres.length ? info.genres : info.tags) : [];
    return {
      id: g.id,
      title: g.title,
      artist: artistName,
      type: g['primary-type'],
      date,
      region: regionOf(info, artistName, g.title),
      genre: genreOf(info, secondary),
      tags: src.slice(0, 3).map((t) => t.name),
    };
  });
  items.sort((a, b) => b.date.localeCompare(a.date) || a.artist.localeCompare(b.artist));

  const out = { generatedAt: new Date().toISOString(), from, to, count: items.length, items };
  await writeFile('data/releases.json', JSON.stringify(out));

  // 오래된 캐시 정리
  const limit = kstDate(-CACHE_KEEP_DAYS);
  for (const [id, v] of Object.entries(cache)) {
    if (!v.seen || v.seen < limit) delete cache[id];
  }
  await writeFile('data/artist-cache.json', JSON.stringify(cache));

  const domestic = items.filter((i) => i.region === 'domestic').length;
  const etc = items.filter((i) => i.genre === '기타').length;
  console.log(`저장 완료: 총 ${items.length}건 (국내 ${domestic} / 해외 ${items.length - domestic} / 장르 미분류 ${etc})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
