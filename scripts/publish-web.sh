#!/bin/bash
# One Netlify site: the public pages at /, and the dashboard app for /sign-in, /overview and the other app paths.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
rm -rf publish
npm ci --prefix mobile_app
# Expo looks for package.json in the current directory. The app is in mobile_app.
cd "$root/mobile_app"
npx expo export --platform web --output-dir "$root/publish"
cd "$root"
mv publish/index.html publish/app.html
cp -a site/. publish/
rm -rf publish/inbox publish/Dockerfile publish/.dockerignore publish/netlify.toml
