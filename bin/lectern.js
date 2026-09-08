#!/usr/bin/env node
// Thin shim so `npx lectern` works without a build step at install time; the
// real entrypoint is compiled from src/server/cli.ts.
require('../out/server/cli.js')
