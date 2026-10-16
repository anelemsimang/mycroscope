#!/bin/bash
# One Netlify site: the public pages at /, and the dashboard app for /sign-in, /overview and the other app paths.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
rm -rf publish
npm ci --prefix mobile_app
npx --prefix mobile_app expo export --platform web --output-dir "$root/publish"
mv publish/index.html publish/app.html
cp -a site/. publish/
rm -rf publish/inbox publish/Dockerfile publish/.dockerignore publish/netlify.toml
