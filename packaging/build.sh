#!/bin/sh
# Builds dist/CapCut-Desk-{mac-arm64,mac-x64,windows-x64}.zip. Needs bun (BUN=/path/to/bun) and zip. bun cross-compiles from one entry file (app/server.mjs).
set -e
cd "$(dirname "$0")/.."
BUN=${BUN:-$HOME/.bun/bin/bun}
VER=$(sed -n "s/.*VERSION='\([0-9.]*\)'.*/\1/p" app/version.mjs)
rm -rf dist; mkdir -p dist/work
for T in mac-arm64:darwin-arm64 mac-x64:darwin-x64 windows-x64:windows-x64; do
  NAME=${T%%:*}; TARGET=${T##*:}; D=dist/work/CapCut-Desk-$NAME; mkdir -p "$D"
  case $NAME in windows*) EXE="CapCut Desk.exe";; *) EXE="CapCut Desk";; esac
  case $NAME in   # Mac: a real app (own window, packaging/mac-window.swift) with the server inside it. Windows: exe + browser.
    mac*) A="$D/CapCut Desk.app/Contents"; R="$A/Resources"; mkdir -p "$A/MacOS" "$R"
          case $NAME in *arm64) SW=arm64;; *) SW=x86_64;; esac
          swiftc -swift-version 5 -O -target $SW-apple-macos12 packaging/mac-window.swift -o "$A/MacOS/CapCutDesk"
          cat > "$A/Info.plist" <<'PL'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>CapCut Desk</string>
<key>CFBundleIdentifier</key><string>local.capcutdesk</string>
<key>CFBundleExecutable</key><string>CapCutDesk</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>LSMinimumSystemVersion</key><string>12.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PL
          sed -i '' "s|<string>1.0</string>|<string>$VER</string>|" "$A/Info.plist"
          ;;
    *) R="$D";;
  esac
  "$BUN" build --compile --target=bun-$TARGET app/main.mjs --outfile "$R/$EXE" >/dev/null
  cp app/index.html "$R/"; cp -R app/vendor "$R/vendor"   # shipped beside the server executable (see ROOT in server.mjs)
  # Cloudflare's tunnel tool for the remote link (app/remote.mjs), official release, cached in packaging/cache
  mkdir -p packaging/cache
  case $NAME in mac-arm64) CF=cloudflared-darwin-arm64.tgz;; mac-x64) CF=cloudflared-darwin-amd64.tgz;; *) CF=cloudflared-windows-amd64.exe;; esac
  [ -s "packaging/cache/$CF" ] || curl -fsSL -o "packaging/cache/$CF" "https://github.com/cloudflare/cloudflared/releases/latest/download/$CF"
  case $CF in *.tgz) tar -xzf "packaging/cache/$CF" -C "$R/vendor" cloudflared;; *) cp "packaging/cache/$CF" "$R/vendor/cloudflared.exe";; esac
  case $NAME in mac*) codesign --force --deep -s - "$D/CapCut Desk.app" 2>/dev/null;; esac
  {
  echo "CapCut Desk - make AI videos with your own CapCut account"
  echo
  echo "HOW TO START"
  case $NAME in
    windows*) echo "1. Unzip the folder anywhere (right-click the zip > Extract All)."
              echo "2. Double-click \"CapCut Desk.exe\". A black window opens (leave it open) and your web browser opens CapCut Desk."
              echo "   If Windows says \"Windows protected your PC\": click \"More info\", then \"Run anyway\".";;
    *)        echo "1. Unzip, then drag \"CapCut Desk\" into your Applications folder."
              echo "2. FIRST TIME ONLY: double-click it. macOS says it could not verify the app. Click Done."
              echo "   Then open System Settings > Privacy & Security, scroll down to \"CapCut Desk was blocked\" and click \"Open Anyway\"."
              echo "   (On older macOS: right-click the app, choose Open, then Open again.)"
              echo "3. Afterwards just double-click \"CapCut Desk\". It opens in its own window. To stop: quit the app (Cmd+Q).";;
  esac
  case $NAME in windows*) cat <<'EOT'
   Keep the files in the folder together. If the browser does not open, go to http://127.0.0.1:38917
   To stop: close the black window. Starting it a second time just opens the page again.
EOT
  esac
  cat <<'EOT'

CONNECT YOUR ACCOUNT
In the page, press "Connect CapCut", then "Open the CapCut approval page" (it opens in your web browser), sign in with the email and password of the CapCut account you were given, and approve.
You will see "Connected as <your name>". If you approve on another device, copy the address the last page ends on and paste it into the box, then press Finish.
Videos use the credits of that account. The price is shown before you add anything to the queue.

USE IT FROM CLAUDE OR CODEX
Open "AI assistants" in the app and press "Add CapCut Desk" next to Claude Code, the Claude desktop app or Codex. Start a new chat there and ask,
for example: "Use CapCut Desk to make a 5 second vertical video of a cat on a windowsill. Tell me the price first."
The assistant uses the same account, queue and credits as the app, and the clips land in the same folder.

WHERE YOUR CLIPS ARE SAVED
In the folder "CapCut Desk" inside your home folder, in a sub-folder per day (for example CapCut Desk/2026-11-14/). The page has an "Open folder" button.
Settings and the sign-in are kept in the hidden folder .capcut-desk in your home folder.

TRY IT FOR FREE (DRY MODE)
DRY mode uses a fake engine: nothing is sent to CapCut and nothing is charged. It shows an orange banner and makes placeholder files instead of videos.
EOT
  case $NAME in
    windows*) echo "Start it from a Command Prompt opened in this folder:  \"CapCut Desk.exe\" --dry";;
    *)        echo "Start it from Terminal:  \"/Applications/CapCut Desk.app/Contents/Resources/CapCut Desk\" --dry   (this mode opens in your web browser)";;
  esac
  echo
  echo "Results made with CapCut carry an \"Ai\" label. Do not remove it."
  } > "$D/README.txt"
  (cd dist/work && zip -qr -X "../CapCut-Desk-$NAME.zip" "CapCut-Desk-$NAME")
done
rm -rf dist/work; ls -l dist
