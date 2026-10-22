# YT Downloader

앱 안에서 YouTube를 보다가 바로 내려받는 Windows·macOS 데스크탑 앱입니다.

- 보고 있는 영상 바로 받기, 링크 우클릭으로 받기, 공유받은 링크 붙여넣어 받기
- 화질 선택: 최고 / 4K / 1440p / 1080p / 720p / MP3
- 호환 우선(H.264) 옵션, 자막(.srt) 같이 받기
- 여러 개 동시 다운로드와 대기열, 진행률·속도·남은 시간 표시
- 완료한 파일 바로 재생, 폴더에서 보기

## 내려받기

[최신 버전 Releases](https://github.com/kyo-vcd/yt-downloader/releases/latest)

### Windows

1. [YT-Downloader-win.zip](https://github.com/kyo-vcd/yt-downloader/releases/latest/download/YT-Downloader-win.zip)을 받아 원하는 폴더에 압축을 풉니다.
2. `YT Downloader.exe`를 실행합니다.

처음 실행할 때 "Windows의 PC 보호" 창이 뜨면 **추가 정보 → 실행**을 누르세요.

### macOS (Apple Silicon)

터미널에 아래 한 줄을 붙여넣으면 응용 프로그램 폴더에 설치하고 실행합니다.

```bash
curl -fsSL https://github.com/kyo-vcd/yt-downloader/releases/latest/download/install.sh | bash
```

[YT-Downloader-mac.zip](https://github.com/kyo-vcd/yt-downloader/releases/latest/download/YT-Downloader-mac.zip)을 브라우저로 직접 받으면 처음 열 때 보안 경고가 뜹니다. 그때는 **시스템 설정 → 개인정보 보호 및 보안 → 그래도 열기**를 누르세요.

## 직접 빌드

```bash
npm install
npm start          # 개발 실행
npm run dist:win   # Windows zip (Windows에서)
npm run dist:mac   # macOS zip (Mac에서)
```

다운로드 엔진으로 [yt-dlp](https://github.com/yt-dlp/yt-dlp)와 [FFmpeg](https://ffmpeg.org)를 사용합니다. yt-dlp는 앱에 포함되어 있고, 새 버전이 나오면 자동으로 업데이트됩니다.

## 주의

본인이 만든 영상이나 내려받을 권리가 있는 콘텐츠에만 사용하세요. 다른 사람의 콘텐츠를 내려받는 것은 YouTube 이용약관과 저작권법에 어긋날 수 있습니다.
