// 빌드 전에 실행: 이 OS용 yt-dlp zip을 vendor/ 에 받아 설치 파일에 함께 넣는다
// (첫 실행 때 인터넷에서 받지 않아도 바로 쓸 수 있게)
const fs = require('fs');
const path = require('path');

const releases = 'https://github.com/yt-dlp/yt-dlp/releases';
const asset = process.platform === 'win32' ? 'yt-dlp_win.zip' : 'yt-dlp_macos.zip';
const outDir = path.join(__dirname, '..', 'vendor');

(async () => {
  const head = await fetch(`${releases}/latest`, { redirect: 'manual' });
  const version = head.headers.get('location')?.split('/').pop();
  if (!version) throw new Error('yt-dlp 최신 버전을 확인하지 못했습니다');
  const res = await fetch(`${releases}/download/${version}/${asset}`);
  if (!res.ok) throw new Error(`yt-dlp 다운로드 실패: ${res.status}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir);
  fs.writeFileSync(path.join(outDir, 'yt-dlp.zip'), Buffer.from(await res.arrayBuffer()));
  fs.writeFileSync(path.join(outDir, 'version.txt'), version);
  console.log(`yt-dlp ${version} (${asset}) → vendor/`);
})().catch(e => { console.error(e.message); process.exit(1); });
