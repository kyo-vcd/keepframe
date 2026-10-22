const $ = id => document.getElementById(id);
const view = $('view');
const isVideo = u => /youtube\.com\/(watch|shorts\/)|youtu\.be\//.test(u);
// 같은 영상이라도 URL(재생목록 파라미터 등)이 다를 수 있어 영상 ID로 중복을 판단한다
const videoId = u => {
  try {
    const x = new URL(u);
    return x.searchParams.get('v') || x.pathname.split('/').filter(Boolean).pop();
  } catch { return u; }
};

let ready = false;
let quality = 'best';
let folder = '';
let nextId = 1;
let running = 0;
const queue = [];         // 순서를 기다리는 항목
const active = new Set(); // 대기 중이거나 받는 중인 '영상 ID|화질'
// 같은 영상은 한 번에 하나씩 받는다. 요청 화질이 달라도 실제 해상도가 같으면 파일 이름이 겹치기 때문
const runningVideos = new Set();
const cards = new Map();  // job id → 카드 DOM

// 설정 저장/복원
const opts = { autoClose: $('optAutoClose'), notify: $('optNotify'), compat: $('optCompat'), subs: $('optSubs') };
for (const [k, el] of Object.entries(opts)) {
  const v = localStorage.getItem('opt.' + k);
  if (v != null) el.checked = v === '1';
  el.onchange = () => localStorage.setItem('opt.' + k, el.checked ? '1' : '0');
}
const maxEl = $('optMax');
maxEl.value = localStorage.getItem('opt.max') || maxEl.value;
maxEl.onchange = () => { localStorage.setItem('opt.max', maxEl.value); pump(); };

// 패널 영역 접기/펴기 상태 기억
for (const d of document.querySelectorAll('details.sec')) {
  const k = 'sec.' + d.dataset.sec;
  if (localStorage.getItem(k) === '0') d.open = false;
  d.ontoggle = () => localStorage.setItem(k, d.open ? '1' : '0');
}

// 완료 기록 (앱을 다시 켜도 목록 유지)
const HISTORY_MAX = 200;
let history = [];
try { history = JSON.parse(localStorage.getItem('history')) || []; } catch {}
const saveHistory = () => localStorage.setItem('history', JSON.stringify(history.slice(0, HISTORY_MAX)));

function setFolder(f) {
  folder = f;
  $('folderInput').value = f;
  $('folderInput').title = f;
  localStorage.setItem('folder', f);
}
// 마지막으로 고른 폴더를 기억한다
const saved = localStorage.getItem('folder');
if (saved) setFolder(saved);
else api.defaultFolder().then(setFolder);

let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

function render() {
  const go = $('go');
  if (!ready) { go.disabled = true; go.textContent = '준비 중…'; return; }
  go.disabled = !isVideo(view.getURL());
  go.textContent = go.disabled ? '영상을 열면 다운로드할 수 있어요' : '이 영상 다운로드';
}

function updateCount() {
  const parts = [];
  if (running) parts.push(`진행 ${running}`);
  if (queue.length) parts.push(`대기 ${queue.length}`);
  $('listTitle').textContent = ['다운로드', ...parts].join(' · ');
}

api.onReady(() => { ready = true; render(); });
api.isReady().then(r => { if (r) { ready = true; render(); } });

// ── 카드 ──
function makeCard(title, label, thumb) {
  const el = document.createElement('div');
  el.className = 'job';
  el.innerHTML = `
    <div class="thumb"></div>
    <div class="body">
      <div class="head"><div class="title"></div><button class="x" title="취소">✕</button></div>
      <div class="track"><div class="fill"></div></div>
      <div class="meta"><span class="state"></span><span class="q"></span></div>
    </div>`;
  el.querySelector('.title').textContent = title;
  el.querySelector('.q').textContent = label;
  if (thumb) setThumb(el, thumb);
  return el;
}

function setThumb(el, url) {
  el.dataset.thumb = url;
  el.querySelector('.thumb').style.backgroundImage = `url(${JSON.stringify(url)})`;
}

function removeCard(el) {
  el.remove();
  if (el.dataset.key) {
    history = history.filter(h => h.key !== el.dataset.key);
    saveHistory();
  }
}

// 완료 상태: 제목 클릭 → 재생, "폴더에서 보기" → 탐색기/Finder에서 파일 선택
function showDone(el, entry) {
  el.className = 'job done';
  el.dataset.key = entry.key || '';
  el.querySelector('.fill').style.width = '100%';
  const title = el.querySelector('.title');
  title.title = entry.file || '';
  title.onclick = async () => {
    const err = entry.file ? await api.openFile(entry.file) : '파일 경로를 알 수 없습니다';
    if (err) toast(err);
  };
  const state = el.querySelector('.state');
  state.textContent = entry.skipped ? '이미 있는 파일 · ' : entry.warning ? `완료 (${entry.warning}) · ` : '완료 · ';
  const b = document.createElement('button');
  b.textContent = '폴더에서 보기';
  b.onclick = async () => {
    const err = entry.file ? await api.showFile(entry.file) : await api.openFolder(entry.folder);
    if (err) toast(err);
  };
  state.append(b);
  // 같은 이름 파일이 있어 건너뛴 경우: 덮어쓰고 다시 받기 (화질을 바꿔 받을 때도 사용)
  if (entry.skipped && entry.job) {
    const again = document.createElement('button');
    again.textContent = '새로 받기';
    again.onclick = () => { removeCard(el); start({ ...entry.job, overwrite: true, title: entry.title, thumb: entry.thumb }); };
    state.append(' · ', again);
  }
  const x = el.querySelector('.x');
  x.title = '목록에서 지우기';
  x.onclick = () => removeCard(el);
}

for (const entry of history) {
  const el = makeCard(entry.title, entry.label, entry.thumb);
  showDone(el, entry);
  $('jobs').append(el);
}

api.onJob(({ id, title, thumb, progress, speed, eta, stage }) => {
  const el = cards.get(id);
  if (!el) return;
  const state = el.querySelector('.state');
  if (title) el.querySelector('.title').textContent = title;
  if (thumb && thumb !== 'NA') setThumb(el, thumb);
  if (stage) { el.dataset.stage = stage; state.textContent = stage; }
  if (progress != null) {
    el.querySelector('.fill').style.width = progress + '%';
    const parts = [el.dataset.stage || '다운로드 중', `${Math.floor(progress)}%`];
    if (speed && !/Unknown/.test(speed)) parts.push(speed.replace('iB', 'B'));
    if (eta && !/Unknown/.test(eta)) parts.push(`${eta} 남음`);
    state.textContent = parts.join(' · ');
  }
});

// ── 대기열 ──
// job: { url, title, thumb, quality, label, folder, compat, subs } — 다시 시도할 때 같은 설정으로 재사용한다
function start(job) {
  if (!ready) return toast('yt-dlp 준비 중입니다');
  const vid = `${videoId(job.url)}|${job.quality}`;
  if (active.has(vid)) return toast('이미 같은 화질로 받고 있는 영상입니다');
  active.add(vid);
  const id = nextId++;
  const el = makeCard(job.title || job.url, job.label, job.thumb);
  el.classList.add('queued');
  el.querySelector('.state').textContent = '대기열';
  $('jobs').prepend(el);
  cards.set(id, el);
  const item = { id, job, el, vid, video: videoId(job.url) };
  el.querySelector('.x').onclick = () => {
    if (el.classList.contains('queued')) {
      queue.splice(queue.indexOf(item), 1);
      finish(item);
      el.remove();
    } else api.cancel(id);
  };
  queue.push(item);
  pump();
}

function pump() {
  for (let i = 0; i < queue.length && running < Number(maxEl.value);) {
    if (runningVideos.has(queue[i].video)) { i++; continue; }
    run(queue.splice(i, 1)[0]);
  }
  updateCount();
}

function finish(item) {
  active.delete(item.vid);
  cards.delete(item.id);
  updateCount();
}

async function run(item) {
  const { id, job, el } = item;
  running++;
  runningVideos.add(item.video);
  el.classList.replace('queued', 'running');
  el.querySelector('.state').textContent = '시작 중';
  const titleOf = () => el.querySelector('.title').textContent;
  try {
    const r = await api.download({ id, url: job.url, quality: job.quality, folder: job.folder, compat: job.compat, subs: job.subs, overwrite: job.overwrite });
    const entry = { key: `h${Date.now()}_${id}`, title: titleOf(), thumb: el.dataset.thumb, file: r.file,
      folder: job.folder, label: job.label, warning: r.warning, skipped: r.skipped, job };
    history.unshift(entry);
    saveHistory();
    showDone(el, entry);
    if (opts.notify.checked) new Notification(r.skipped ? '이미 있는 파일' : '다운로드 완료', { body: entry.title });
    if (opts.autoClose.checked) setTimeout(() => removeCard(el), 3000);
  } catch (e) {
    el.className = 'job fail';
    const state = el.querySelector('.state');
    state.textContent = '실패 또는 취소됨 · ';
    state.title = e.message;
    const b = document.createElement('button');
    b.textContent = '다시 시도';
    b.onclick = () => { el.remove(); start({ ...job, title: titleOf(), thumb: el.dataset.thumb }); };
    state.append(b);
    const x = el.querySelector('.x');
    x.title = '닫기';
    x.onclick = () => el.remove();
  } finally {
    running--;
    runningVideos.delete(item.video);
    finish(item);
    pump();
  }
}

function download(url, title) {
  start({
    url, title, quality, folder,
    label: $('quality').querySelector('.on').textContent + (opts.compat.checked && quality !== 'mp3' ? ' · H.264' : ''),
    compat: opts.compat.checked, subs: opts.subs.checked,
  });
}

api.onDownloadUrl(url => download(url));
api.onToast(toast);

$('go').onclick = () => download(view.getURL(), view.getTitle().replace(/ - YouTube$/, ''));

// 공유받은 링크: 여러 개를 한 번에 붙여넣어도 각각 받는다
function downloadPasted() {
  if (!ready) return toast('yt-dlp 준비 중입니다');
  const urls = ($('urlInput').value.match(/https?:\/\/\S+/g) || []).filter(isVideo);
  if (!urls.length) return toast('YouTube 영상 링크를 붙여넣으세요');
  urls.forEach(u => download(u));
  $('urlInput').value = '';
}
$('urlInput').onkeydown = e => { if (e.key === 'Enter') downloadPasted(); };
$('urlGo').onclick = downloadPasted;

$('quality').onclick = e => {
  const b = e.target.closest('button');
  if (!b) return;
  quality = b.dataset.q;
  for (const x of $('quality').children) x.classList.toggle('on', x === b);
};

// 저장 경로: 직접 입력(Enter) 또는 폴더 선택
$('folderInput').onkeydown = e => { if (e.key === 'Enter') e.target.blur(); };
$('folderInput').onchange = () => {
  const v = $('folderInput').value.trim();
  if (/^([a-zA-Z]:[\\/]|\/|\\\\)/.test(v)) setFolder(v);
  else { toast('전체 경로를 입력하세요 (예: D:\\Videos)'); setFolder(folder); }
};
$('pick').onclick = async () => {
  const f = await api.pickFolder();
  if (f) setFolder(f);
};
$('openFolder').onclick = () => api.openFolder(folder);

$('clearDone').onclick = () => {
  for (const el of [...$('jobs').children]) if (!el.classList.contains('running') && !el.classList.contains('queued')) el.remove();
  history = [];
  saveHistory();
};

// 브라우저 조작
$('back').onclick = () => view.canGoBack() && view.goBack();
$('fwd').onclick = () => view.canGoForward() && view.goForward();
$('reload').onclick = () => view.reload();
$('home').onclick = () => view.loadURL('https://www.youtube.com');
$('address').onkeydown = e => {
  if (e.key !== 'Enter') return;
  const v = $('address').value.trim();
  view.loadURL(/^https?:\/\//.test(v) ? v
    : 'https://www.youtube.com/results?search_query=' + encodeURIComponent(v));
};
// YouTube는 SPA라서 did-navigate-in-page 도 같이 봐야 한다
const onNav = () => { $('address').value = view.getURL(); render(); };
view.addEventListener('did-navigate', onNav);
view.addEventListener('did-navigate-in-page', onNav);
// 포커스가 반대쪽에 있으면 첫 클릭·마우스 올림(:hover, 툴팁)이 먹지 않는다.
// 마우스가 브라우저 화면에 들어오고 나갈 때(main.js가 심은 신호) 포커스를 옮겨 준다
view.addEventListener('console-message', e => {
  if (e.message === '__keepframe_mouseleave') view.blur();
  // 패널 입력칸에 글을 쓰는 중이면 포커스를 빼앗지 않는다
  if (e.message === '__keepframe_mouseenter' && !document.activeElement.matches('input, textarea, select')) view.focus();
});
