const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// asar로 패키징되면 ffmpeg 바이너리는 app.asar.unpacked 에 있다
const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

// 예전 이름(yt-downloader) 때의 설정·다운로드 기록을 새 이름 폴더로 옮긴다
// (Electron이 새 폴더를 먼저 만들어 두므로 폴더째가 아니라 안의 항목을 하나씩 옮긴다)
const oldData = path.join(app.getPath('appData'), 'yt-downloader');
const userData = app.getPath('userData');
if (fs.existsSync(oldData) && !fs.existsSync(path.join(userData, 'Local Storage'))) {
  fs.mkdirSync(userData, { recursive: true });
  for (const name of fs.readdirSync(oldData)) {
    const to = path.join(userData, name);
    if (!fs.existsSync(to)) try { fs.renameSync(path.join(oldData, name), to); } catch {}
  }
  try { fs.rmdirSync(oldData); } catch {} // 다 옮겨서 비었을 때만 지워진다
}

const isWin = process.platform === 'win32';
const binDir = path.join(app.getPath('userData'), 'bin');
// 단일 exe 버전은 실행할 때마다 내부 파일을 임시 폴더에 풀어서(백신 검사 포함) 시작이 수십 초 걸린다.
// 압축을 미리 풀어두는 zip 배포판을 쓴다
const ytdlpDir = path.join(binDir, 'yt-dlp');
const ytdlpPath = path.join(ytdlpDir, isWin ? 'yt-dlp.exe' : 'yt-dlp_macos');
const versionFile = path.join(binDir, 'version.txt');
const releases = 'https://github.com/yt-dlp/yt-dlp/releases';
const zipUrl = `${releases}/latest/download/${isWin ? 'yt-dlp_win.zip' : 'yt-dlp_macos.zip'}`;

let win;
let ytdlpReady = false;
const jobs = new Map(); // 다운로드 id → 프로세스 (동시 다운로드)

function unzip(zip, dir) {
  const [cmd, args] = isWin
    ? [path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xf', zip, '-C', dir]]
    : ['ditto', ['-x', '-k', zip, dir]];
  return new Promise((resolve, reject) =>
    spawn(cmd, args).on('error', reject)
      .on('close', code => (code === 0 ? resolve() : reject(new Error('yt-dlp 압축 해제 실패')))));
}

// 새 버전은 tmpDir에 먼저 풀어 두고, swap()으로 교체한다
const tmpDir = ytdlpDir + '.new';

async function extract(zip) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  await unzip(zip, tmpDir);
}

// 기존 폴더를 옆으로 치워 둔 뒤 교체한다. 도중에 실패하면 원래대로 되돌린다
function swap(version) {
  const oldDir = ytdlpDir + '.old';
  fs.rmSync(oldDir, { recursive: true, force: true });
  if (fs.existsSync(ytdlpDir)) fs.renameSync(ytdlpDir, oldDir);
  try {
    fs.renameSync(tmpDir, ytdlpDir);
  } catch (e) {
    if (fs.existsSync(oldDir)) fs.renameSync(oldDir, ytdlpDir);
    throw e;
  }
  fs.writeFileSync(versionFile, version || '');
  fs.rmSync(oldDir, { recursive: true, force: true });
}

async function latestVersion() {
  try {
    const res = await fetch(`${releases}/latest`, { redirect: 'manual' });
    return res.headers.get('location')?.split('/').pop() || null;
  } catch { return null; }
}

async function downloadLatest() {
  const zip = path.join(binDir, 'yt-dlp.zip');
  try {
    const res = await fetch(zipUrl);
    if (!res.ok) throw new Error(`yt-dlp 다운로드 실패: ${res.status}`);
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    await extract(zip);
  } finally {
    fs.rmSync(zip, { force: true });
  }
}

const installedVersion = () => (fs.existsSync(ytdlpPath) && fs.existsSync(versionFile)
  ? fs.readFileSync(versionFile, 'utf8') : null);

// 쓸 수 있는 yt-dlp를 확보한다. 이미 있으면 바로 끝나고, 업데이트는 updateYtdlp()가 뒤에서 한다
async function ensureYtdlp() {
  fs.mkdirSync(binDir, { recursive: true });
  fs.rmSync(path.join(binDir, isWin ? 'yt-dlp.exe' : 'yt-dlp'), { force: true }); // 예전 단일 exe 정리
  if (installedVersion() != null) return;

  // 설치 파일에 함께 넣어 둔 버전을 설치한다 (첫 실행 때 인터넷 없이도 바로 사용)
  const bundled = path.join(process.resourcesPath, 'yt-dlp');
  try {
    await extract(path.join(bundled, 'yt-dlp.zip'));
    swap(fs.readFileSync(path.join(bundled, 'version.txt'), 'utf8'));
    return;
  } catch {}

  // 넣어 둔 것이 없으면(개발 모드 등) 받아야 쓸 수 있다
  const latest = await latestVersion();
  await downloadLatest();
  swap(latest);
}

// 새 버전을 뒤에서 받아 두었다가, 진행 중인 다운로드가 없을 때 교체한다
// (YouTube 변경에 대응하려면 최신 유지가 중요. 실행 중인 yt-dlp 파일은 바꿀 수 없다)
let pendingVersion = null;

function applyPending() {
  if (pendingVersion == null || jobs.size) return;
  try { swap(pendingVersion); } catch {}
  pendingVersion = null;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function updateYtdlp() {
  const latest = await latestVersion();
  if (!latest || latest === installedVersion()) return;
  try {
    await downloadLatest();
    pendingVersion = latest;
    applyPending();
  } catch {
    fs.rmSync(tmpDir, { recursive: true, force: true }); // 실패하면 기존 버전으로 계속 쓴다
  }
}

function run(args, onLine, onSpawn) {
  return new Promise((resolve, reject) => {
    // YouTube 추출에 JS 런타임이 필요하다. Electron 자신을 Node로 실행해 넘겨준다
    // Windows 콘솔 기본 인코딩(cp949)이 아닌 UTF-8로 출력하게 해야 한글 제목이 안 깨진다
    const p = spawn(ytdlpPath, ['--encoding', 'utf-8', '--js-runtimes', `node:${process.execPath}`, ...args],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PYTHONIOENCODING: 'utf-8' } });
    p.stdout.setEncoding('utf8'); // 청크 경계에서 멀티바이트 문자가 잘려도 안전하게 디코딩
    p.stderr.setEncoding('utf8');
    let out = '', err = '', partial = '';
    p.stdout.on('data', d => {
      out += d;
      if (!onLine) return;
      // 줄이 청크 사이에 걸칠 수 있으므로 마지막 미완성 줄은 다음 청크와 합친다
      const lines = (partial + d).split(/\r?\n/);
      partial = lines.pop();
      lines.forEach(l => l && onLine(l));
    });
    p.stderr.on('data', d => (err += d));
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `종료 코드 ${code}`))));
    if (onSpawn) onSpawn(p);
  });
}

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// yt-dlp 로그 → 카드에 보여줄 진행 단계
const STAGES = [
  [/^\[youtube\]/, '정보 확인 중'],
  [/Sleeping/, 'YouTube 대기 중'],
  [/^\[download\] Destination:/, '다운로드 중'],
  [/has already been downloaded/, '이미 받은 파일'],
  [/^\[Merger\]/, '합치는 중'],
  [/^\[ExtractAudio\]/, 'MP3 변환 중'],
];

ipcMain.handle('download', async (_e, { id, url, quality, folder, compat, subs, overwrite }) => {
  const args = ['--no-playlist', '--newline', '--ffmpeg-location', ffmpegPath,
    // 제목·썸네일·최종 파일 경로를 출력한다. --print는 quiet를 켜므로 --no-quiet로 진행 로그를 다시 켠다
    '--no-simulate', '--no-quiet',
    '--print', 'before_dl:[title] %(title)s', '--print', 'before_dl:[thumb] %(thumbnail)s',
    '--print', 'after_move:[file] %(filepath)s',
    // 파일 이름 뒤에 실제 해상도를 붙여 화질이 다른 파일끼리 덮어쓰지 않게 한다 (예: 제목 [720p].mp4)
    '-o', path.join(folder, quality === 'mp3' ? '%(title)s.%(ext)s' : '%(title)s%(height& [{}p]|)s.%(ext)s')];
  if (quality === 'mp3') {
    args.push('-x', '--audio-format', 'mp3');
  } else {
    const h = quality === 'best' ? '' : `[height<=${quality}]`;
    // 영상·음성을 각각 최고 품질로 받아 합친다. 음성은 MP4 호환이 좋은 AAC(m4a) 우선
    let f = `bv*${h}+ba[ext=m4a]/bv*${h}+ba/b${h}`;
    // 호환 우선: 어디서나 재생되는 H.264(avc1)를 먼저 고른다 (YouTube에선 최대 1080p)
    if (compat) f = `bv*[vcodec^=avc1]${h}+ba[ext=m4a]/b[vcodec^=avc1]${h}/` + f;
    args.push('-f', f, '--merge-output-format', 'mp4');
    if (subs) args.push('--write-subs', '--write-auto-subs', '--sub-langs', 'ko,en', '--convert-subs', 'srt');
  }
  if (overwrite) args.push('--force-overwrites'); // '새로 받기': 같은 이름 파일이 있어도 다시 받는다
  args.push(url);
  let file = null;
  let skipped = false; // 같은 이름 파일이 이미 있어 yt-dlp가 건너뛴 경우
  try {
    await run(args, line => {
      const t = line.match(/^\[(title|thumb|file)\] (.*)/);
      if (t && t[1] === 'file') file = t[2];
      if (/has already been downloaded/.test(line)) skipped = true;
      else if (t) win.webContents.send('job', { id, [t[1]]: t[2] });
      const m = line.match(/\[download\]\s+([\d.]+)% of .*? at\s+(\S+)\s+ETA\s+(\S+)/) ||
        line.match(/\[download\]\s+([\d.]+)%/);
      if (m) win.webContents.send('job', { id, progress: parseFloat(m[1]), speed: m[2], eta: m[3] });
      const s = STAGES.find(([re]) => re.test(line));
      if (s) win.webContents.send('job', { id, stage: s[1] });
    }, p => jobs.set(id, p));
    return { file, skipped };
  } catch (e) {
    // 자막 요청이 YouTube에 막혀도(429) 영상 파일이 만들어졌으면 성공으로 본다
    if (file && fs.existsSync(file)) return { file, warning: '자막 일부 실패' };
    throw e;
  } finally {
    jobs.delete(id);
    applyPending(); // 받아 둔 새 yt-dlp가 있으면 다운로드가 모두 끝났을 때 교체
  }
});

function kill(p) {
  // Windows의 yt-dlp.exe는 자식 프로세스를 띄우므로 트리째 종료해야 실제로 멈춘다
  if (isWin) spawn('taskkill', ['/pid', String(p.pid), '/T', '/F']);
  else p.kill();
}
ipcMain.handle('cancel', (_e, id) => {
  const p = jobs.get(id);
  if (p) kill(p);
});
ipcMain.handle('open-folder', (_e, folder) => shell.openPath(folder));
ipcMain.handle('open-file', (_e, file) => (fs.existsSync(file) ? shell.openPath(file) : '파일을 찾을 수 없습니다'));
ipcMain.handle('show-file', (_e, file) => {
  if (!fs.existsSync(file)) return '파일을 찾을 수 없습니다';
  shell.showItemInFolder(file);
  return '';
});
ipcMain.handle('is-ready', () => ytdlpReady); // 화면을 새로고침해도 준비 상태를 알 수 있게
ipcMain.handle('default-folder', () => app.getPath('downloads'));

// 내장 브라우저에서 영상 링크 우클릭 → 바로 다운로드
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.on('context-menu', (_e, params) => {
    const url = params.linkURL || contents.getURL();
    Menu.buildFromTemplate([
      { label: params.linkURL ? '이 링크 영상 다운로드' : '이 영상 다운로드', click: () => win.webContents.send('download-url', url) },
    ]).popup();
  });
  // 새 창으로 열리는 링크는 같은 webview에서 연다
  contents.setWindowOpenHandler(({ url }) => {
    if (!blockLogin(url)) contents.loadURL(url);
    return { action: 'deny' };
  });
  // 로그인 없이 쓰는 앱이다. Google은 내장 브라우저에서의 로그인을 막으므로 로그인 버튼을 숨기고 이동도 막는다
  contents.on('will-navigate', (e, url) => blockLogin(url) && e.preventDefault());
  contents.on('will-redirect', (e, url) => blockLogin(url) && e.preventDefault());
  contents.on('dom-ready', () => {
    contents.insertCSS(
      'a[href*="accounts.google.com"], ytd-button-renderer:has(a[href*="accounts.google.com"]) { display: none !important; }');
    // 마우스가 브라우저 화면에 들어오고 나갈 때 앱 화면에 알린다 (renderer.js에서 포커스를 옮겨 한 번 클릭으로 동작하게)
    contents.executeJavaScript("for (const t of ['mouseenter', 'mouseleave']) "
      + "document.documentElement.addEventListener(t, () => console.log('__keepframe_' + t))");
  });
});

function blockLogin(url) {
  if (!/^https:\/\/accounts\.google\.com\//.test(url)) return false;
  win.webContents.send('toast', '로그인 없이 사용하는 앱입니다');
  return true;
}

app.whenReady().then(async () => {
  // 일부 사이트가 Electron UA를 차단하므로 일반 Chrome UA 사용
  app.userAgentFallback = app.userAgentFallback.replace(/ (Electron|keepframe)\/\S+/gi, '');
  win = new BrowserWindow({
    width: 1400, height: 880,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), webviewTag: true },
  });
  win.setMenuBarVisibility(false);
  // 메인 창은 로컬 UI만 띄운다. 링크·파일을 끌어다 놓아 외부 페이지로 이동하면 preload API가 노출되므로 막는다
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile('index.html');
  try {
    // 페이지 로드 전에 보내면 렌더러가 'ready'를 놓친다
    await Promise.all([ensureYtdlp(), new Promise(r => win.webContents.once('did-finish-load', r))]);
    ytdlpReady = true;
    win.webContents.send('ready');
  } catch (e) {
    dialog.showErrorBox('초기화 실패', e.message);
    return;
  }
  updateYtdlp(); // 기다리지 않는다

});

app.on('window-all-closed', () => app.quit());
// 앱을 닫으면 진행 중인 다운로드도 끝낸다 (안 그러면 yt-dlp가 뒤에서 계속 돈다)
app.on('before-quit', () => jobs.forEach(kill));
