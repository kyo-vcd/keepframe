const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// asar로 패키징되면 ffmpeg 바이너리는 app.asar.unpacked 에 있다
const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

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

// 설치돼 있지 않거나 새 버전이 나왔으면 받는다 (YouTube 변경에 대응하려면 최신 유지가 중요)
async function ensureYtdlp() {
  const installed = fs.existsSync(ytdlpPath) && fs.existsSync(versionFile)
    ? fs.readFileSync(versionFile, 'utf8') : null;
  let latest;
  try {
    const res = await fetch(`${releases}/latest`, { redirect: 'manual' });
    latest = res.headers.get('location')?.split('/').pop();
  } catch {}
  if (installed != null && (!latest || installed === latest)) return;

  fs.mkdirSync(binDir, { recursive: true });
  fs.rmSync(path.join(binDir, isWin ? 'yt-dlp.exe' : 'yt-dlp'), { force: true }); // 예전 단일 exe 정리
  const res = await fetch(zipUrl);
  if (!res.ok) throw new Error(`yt-dlp 다운로드 실패: ${res.status}`);
  const zip = path.join(binDir, 'yt-dlp.zip');
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  fs.rmSync(ytdlpDir, { recursive: true, force: true });
  fs.mkdirSync(ytdlpDir);
  await unzip(zip, ytdlpDir);
  fs.rmSync(zip);
  fs.writeFileSync(versionFile, latest || '');
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

ipcMain.handle('download', async (_e, { id, url, quality, folder, compat, subs }) => {
  const args = ['--no-playlist', '--newline', '--ffmpeg-location', ffmpegPath,
    // 제목·썸네일·최종 파일 경로를 출력한다. --print는 quiet를 켜므로 --no-quiet로 진행 로그를 다시 켠다
    '--no-simulate', '--no-quiet',
    '--print', 'before_dl:[title] %(title)s', '--print', 'before_dl:[thumb] %(thumbnail)s',
    '--print', 'after_move:[file] %(filepath)s',
    '-o', path.join(folder, '%(title)s.%(ext)s')];
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
  args.push(url);
  let file = null;
  try {
    await run(args, line => {
      const t = line.match(/^\[(title|thumb|file)\] (.*)/);
      if (t && t[1] === 'file') file = t[2];
      else if (t) win.webContents.send('job', { id, [t[1]]: t[2] });
      const m = line.match(/\[download\]\s+([\d.]+)% of .*? at\s+(\S+)\s+ETA\s+(\S+)/) ||
        line.match(/\[download\]\s+([\d.]+)%/);
      if (m) win.webContents.send('job', { id, progress: parseFloat(m[1]), speed: m[2], eta: m[3] });
      const s = STAGES.find(([re]) => re.test(line));
      if (s) win.webContents.send('job', { id, stage: s[1] });
    }, p => jobs.set(id, p));
    return { file };
  } catch (e) {
    // 자막 요청이 YouTube에 막혀도(429) 영상 파일이 만들어졌으면 성공으로 본다
    if (file && fs.existsSync(file)) return { file, warning: '자막 일부 실패' };
    throw e;
  } finally {
    jobs.delete(id);
  }
});

ipcMain.handle('cancel', (_e, id) => {
  const p = jobs.get(id);
  if (!p) return;
  // Windows의 yt-dlp.exe는 자식 프로세스를 띄우므로 트리째 종료해야 실제로 멈춘다
  if (isWin) spawn('taskkill', ['/pid', String(p.pid), '/T', '/F']);
  else p.kill();
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
    contents.loadURL(url);
    return { action: 'deny' };
  });
});

app.whenReady().then(async () => {
  // 일부 사이트가 Electron UA를 차단하므로 일반 Chrome UA 사용
  app.userAgentFallback = app.userAgentFallback.replace(/ (Electron|yt-downloader)\/\S+/g, '');
  win = new BrowserWindow({
    width: 1400, height: 880,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), webviewTag: true },
  });
  win.setMenuBarVisibility(false);
  win.loadFile('index.html');
  try {
    // 페이지 로드 전에 보내면 렌더러가 'ready'를 놓친다
    await Promise.all([ensureYtdlp(), new Promise(r => win.webContents.once('did-finish-load', r))]);
    ytdlpReady = true;
    win.webContents.send('ready');
  } catch (e) {
    dialog.showErrorBox('초기화 실패', e.message);
  }
});

app.on('window-all-closed', () => app.quit());
