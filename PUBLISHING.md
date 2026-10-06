Anime Frame is published publicly on Sites. The project identity is saved in
`.openai/hosting.json`.

The original `index.html`, `live.js`, and `serve.py` remain the local version.
`npm run build` uses `scripts/build-sites.mjs` to adapt the frontend for hosting
and bundle it with `hosting/worker.js` into `dist/server/index.js`.

The public version uses visitors' Decart keys, kept in the browser tab's
sessionStorage. The Worker exchanges them for five-minute, origin-scoped client
tokens without persisting keys. No values from `.env` enter the build or source
repository. `PUBLIC_SITE_ORIGIN` is configured as a runtime environment variable
in Sites so token origins match the public domain.

Video conversion runs locally with the single-threaded ffmpeg.wasm core. Files
that need conversion are limited to 200 MB; browser-playable videos can be opened
without conversion. Native MP4 recordings download directly; WebM recordings are
converted when possible and otherwise download in their original format.

The vendored JavaScript wrapper is `@ffmpeg/ffmpeg` 0.12.15 (MIT license). The core
is `@ffmpeg/core` 0.12.10, downloaded from jsDelivr only when conversion is needed.

Publish with the Sites hosting skill: run the build through the Site workflow,
save its source commit and archive, and deploy the saved version. Keep the
existing project ID and public access setting for subsequent updates.
