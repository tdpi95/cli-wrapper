#!/usr/bin/env node
// Thin, uncompiled entrypoint so this package works as a `bin` command
// (e.g. after `npm install -g`) regardless of where it's installed. The
// actual server lives in dist/, built from src/ by `npm run build`.
import "../dist/server.js";
