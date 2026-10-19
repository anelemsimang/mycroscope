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
node --input-type=module -e "import fs from 'node:fs'; const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? ''; const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? ''; fs.writeFileSync('publish/js/billing-config.js', 'window.MYCROSCOPE_BILLING = ' + JSON.stringify({ url, anonKey }) + ';\n');"
# Checkout uses the same Supabase client as the dashboard, served from this site rather than a third-party address.
npx --yes esbuild "$root/mobile_app/node_modules/@supabase/supabase-js/dist/index.mjs" --bundle --format=esm --outfile="$root/publish/js/supabase.js"
npx --yes esbuild "$root/mobile_app/src/lib/receipt.ts" --bundle --format=esm --platform=browser --outfile="$root/publish/js/receipt.js"
