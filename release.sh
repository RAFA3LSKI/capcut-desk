#!/bin/sh
# Release: sh release.sh   (bump app/version.mjs first, commit everything, then run this)
# Tests -> build (wipes dist/) -> tag vX.Y.Z -> push -> GitHub release with the 3 zips. Needs gh logged in, bun, swiftc, zip.
set -e
cd "$(dirname "$0")"
VER=$(sed -n "s/.*VERSION='\([0-9.]*\)'.*/\1/p" app/version.mjs); [ -n "$VER" ] || { echo "no version in app/version.mjs"; exit 1; }
TAG=v$VER; REPO=RAFA3LSKI/capcut-desk
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "Uncommitted changes: commit first."; exit 1; }
git rev-parse "$TAG" >/dev/null 2>&1 && { echo "Tag $TAG already exists: bump app/version.mjs."; exit 1; }
node app/queue.test.mjs >/dev/null && node app/update.test.mjs
sh packaging/build.sh
git tag "$TAG" && git push origin HEAD "$TAG"
NOTES=${NOTES:-"CapCut Desk $VER. Mac Apple Silicon and Intel; Windows zip is untested. First open on Mac: System Settings > Privacy & Security > Open Anyway. See README.md."}
gh release create "$TAG" dist/CapCut-Desk-mac-arm64.zip dist/CapCut-Desk-mac-x64.zip dist/CapCut-Desk-windows-x64.zip --repo "$REPO" --title "CapCut Desk $VER" --notes "$NOTES"
