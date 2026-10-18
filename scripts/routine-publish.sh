#!/usr/bin/env bash
# Publish one edition to the feed and push it. Run by the daily routine after it builds the day's JSON.
# Usage: scripts/routine-publish.sh /path/to/edition.json
# Env:   FEED_BRANCH (default main), NO_PUSH=1 to commit locally only.
# Exit:  0 published, unchanged, or skipped as a near-duplicate of a recent day; 1 lint failed or push failed.
# Result marker: the outcome is also written to $FEED_RESULT_FILE (default /tmp/tldr-feed-result) as one word:
#        published | unchanged | duplicate | failed.  The routine builds the podcast only after "published".
set -euo pipefail
cd "$(dirname "$0")/.."
ED="${1:?usage: routine-publish.sh edition.json}"
BRANCH="${FEED_BRANCH:-main}"
RESULT_FILE="${FEED_RESULT_FILE:-/tmp/tldr-feed-result}"
result() { echo "$1" > "$RESULT_FILE" 2>/dev/null || true; }
result failed
DATE=$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).date" "$ED")

publish_once() {
  git fetch -q origin "$BRANCH"
  git checkout -q -B "$BRANCH" "origin/$BRANCH"        # always start from the latest remote state
  # set -e is off inside a function called with ||, so every step checks itself
  local prc=0
  node scripts/publish-feed.js "$ED" || prc=$?           # sanitize + lint + duplicate check, rebuild the index
  if [ "$prc" = 3 ]; then echo "skipped duplicate for $DATE"; return 3; fi
  [ "$prc" = 0 ] || return 1
  node scripts/lint-feed.js || return 1                  # lint the whole feed
  git add feed || return 1
  if git diff --cached --quiet; then echo "feed unchanged for $DATE"; return 2; fi
  git -c user.name="TLDR Feed Bot" -c user.email="noreply@anthropic.com" commit -q -m "feed: $DATE" || return 1
}

for attempt in 1 2 3 4; do
  rc=0; publish_once || rc=$?
  if [ "$rc" = 2 ]; then result unchanged; exit 0; fi
  if [ "$rc" = 3 ]; then result duplicate; exit 0; fi
  if [ "$rc" != 0 ]; then echo "LINT FAIL: nothing pushed" >&2; result failed; exit 1; fi
  if [ "${NO_PUSH:-}" = 1 ]; then echo "NO_PUSH set: committed locally, not pushed"; result published; exit 0; fi
  if git push -q origin "HEAD:$BRANCH"; then echo "pushed feed: $DATE"; result published; exit 0; fi
  echo "push attempt $attempt failed, retrying" >&2
  sleep $((2 ** attempt))
done
echo "PUSH FAIL after 4 attempts" >&2
result failed
exit 1
