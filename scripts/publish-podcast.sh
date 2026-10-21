#!/usr/bin/env bash
# Turn a two-host script into audio and publish it as the single "latest" podcast.
#
# Usage: scripts/publish-podcast.sh /path/to/script.txt --date YYYY-MM-DD
#
# What it does, in order (any failure stops the run and publishes nothing):
#   1. lints the script (format, length, no URLs or emails, speakable numbers)
#   2. checks --date is the newest edition in feed/index.json (the app only shows Listen for that day)
#   3. synthesizes with scripts/podcast/synth.py: Google Chirp 3 HD voices first, local Kokoro if Google fails
#      (Kokoro is installed only when it is needed)
#   4. lints the result (mp3 really is an mp3, duration 4 to 10 minutes, hash and size match podcast.json)
#   5. force-pushes ONE commit holding latest.mp3 and podcast.json to the "podcast" branch.
#      The branch is replaced every day, so old audio never piles up in the repository history.
#
# Env: PODCAST_ENGINE (google, the default, or kokoro to skip Google), PODCAST_BRANCH (default podcast), PODCAST_BITRATE (default 128k), PODCAST_WORK (work folder),
#      PODCAST_SYNTH (alternative synth command, used by tests), NO_PUSH=1 (build and lint, do not push),
#      PODCAST_REMOTE (git remote URL; default is this repo's origin).
# Exit: 0 published, 1 failed (nothing pushed).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
SCRIPT="${1:?usage: publish-podcast.sh script.txt --date YYYY-MM-DD}"; shift
DATE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --date) DATE="${2:?--date needs a value}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done
[[ "$DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "PODCAST FAIL: --date YYYY-MM-DD is required" >&2; exit 1; }
BRANCH="${PODCAST_BRANCH:-podcast}"
FEED_DIR="${FEED_DIR:-$ROOT/feed}"
WORK="${PODCAST_WORK:-$(mktemp -d)}"
mkdir -p "$WORK"
fail() { echo "PODCAST FAIL: $*" >&2; exit 1; }

echo "== 1/5 lint script"
node scripts/lint-podcast-script.js "$SCRIPT" || fail "script did not pass lint"

echo "== 2/5 check the date matches the latest edition"
NEWEST=$(node -e "const i=JSON.parse(require('fs').readFileSync(process.argv[1]+'/index.json','utf8'));console.log(i.editions.map(e=>e.date).sort().pop()||'')" "$FEED_DIR") || fail "cannot read feed/index.json"
[ "$NEWEST" = "$DATE" ] || fail "--date $DATE is not the latest edition ($NEWEST). The app only offers Listen for the latest edition."

echo "== 3/5 synthesize"
if [ -n "${PODCAST_SYNTH:-}" ]; then
  $PODCAST_SYNTH --script "$SCRIPT" --out "$WORK" --date "$DATE" || fail "synthesis failed"
else
  command -v ffmpeg >/dev/null || fail "ffmpeg is required"
  ENGINE="${PODCAST_ENGINE:-google}"      # google = Chirp 3 HD voices first; kokoro = local fallback
  BITRATE="${PODCAST_BITRATE:-128k}"
  if [ "$ENGINE" = google ]; then
    python3 -c "import numpy, soundfile" 2>/dev/null || python3 -m pip install --break-system-packages -q numpy soundfile || fail "pip install failed"
    if python3 scripts/podcast/synth.py --engine google --script "$SCRIPT" --out "$WORK" --date "$DATE" --bitrate "$BITRATE"; then
      echo "engine: google (Chirp 3 HD)"
    else
      echo "google synthesis failed, falling back to kokoro" >&2
      rm -f "$WORK/latest.mp3" "$WORK/latest.wav" "$WORK/podcast.json"
      ENGINE=kokoro
    fi
  fi
  if [ "$ENGINE" = kokoro ]; then
    python3 -c "import kokoro_onnx, soundfile" 2>/dev/null || {
      echo "installing kokoro-onnx and soundfile"
      python3 -m pip install --break-system-packages -q kokoro-onnx soundfile || fail "pip install failed"
    }
    python3 scripts/podcast/synth.py --engine kokoro --script "$SCRIPT" --out "$WORK" --date "$DATE" --bitrate "$BITRATE" || fail "synthesis failed"
    echo "engine: kokoro"
  fi
fi

echo "== 4/5 lint result"
node scripts/lint-podcast.js "$WORK/podcast.json" "$WORK/latest.mp3" || fail "audio did not pass lint"

if [ "${NO_PUSH:-}" = 1 ]; then echo "NO_PUSH set: built in $WORK, not pushed"; exit 0; fi

echo "== 5/5 publish to the $BRANCH branch"
REMOTE="${PODCAST_REMOTE:-$(git remote get-url origin)}"
PUB="$(mktemp -d)"
cp "$WORK/latest.mp3" "$WORK/podcast.json" "$PUB/"
git -C "$PUB" init -q -b "$BRANCH"
git -C "$PUB" add latest.mp3 podcast.json
git -C "$PUB" -c user.name="TLDR Feed Bot" -c user.email="noreply@anthropic.com" commit -q -m "podcast: $DATE"
ok() { echo "published podcast for $DATE ($(node -p "(require('fs').statSync(process.argv[1]).size/1e6).toFixed(1)" "$WORK/latest.mp3") MB)"; exit 0; }
for attempt in 1 2 3 4; do
  if git -C "$PUB" push -q --force "$REMOTE" "HEAD:refs/heads/$BRANCH"; then ok; fi
  if [ "$attempt" -ge 2 ]; then
    # some servers refuse force pushes: replace the branch by deleting it, then pushing it fresh
    echo "force push refused, replacing the branch by delete and push" >&2
    git -C "$PUB" push -q "$REMOTE" --delete "$BRANCH" 2>/dev/null || true
    if git -C "$PUB" push -q "$REMOTE" "HEAD:refs/heads/$BRANCH"; then ok; fi
  fi
  echo "push attempt $attempt failed, retrying" >&2
  sleep $((2 ** attempt))
done
fail "push failed after 4 attempts"
