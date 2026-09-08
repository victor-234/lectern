#!/bin/sh
# Lectern turn checkpoints — hands Claude Code's hook payload to the running app
# so it can snapshot the project before a turn and show you the diff afterwards.
#
# Fire-and-forget by design: this exits 0 on every path, so a closed, restarting
# or uninstalled Lectern can never block, slow or break your Claude session.
# Managed by Lectern; edits here are overwritten.
f="$HOME/.lctrn/bridge"
[ -r "$f" ] || exit 0
read -r port token < "$f" || exit 0
[ -n "$port" ] && [ -n "$token" ] || exit 0
curl -sS -m 20 -X POST "http://127.0.0.1:$port/hook" \
  -H 'content-type: application/json' \
  -H "x-lctrn-token: $token" \
  --data-binary @- >/dev/null 2>&1
exit 0
