#!/usr/bin/env python3
"""Two-host podcast synthesis. Engines: Google Cloud Text-to-Speech Chirp 3 HD voices (--engine google, the first
choice) or local Kokoro (kokoro-onnx, no cloud, no quota). publish-podcast.sh tries Google and falls back to Kokoro.

Reads a script made of lines like
    HOST_A: <text>
    HOST_B: <text>
and writes, into --out:
    latest.mp3     mono mp3 (default 128 kbps, 44.1 kHz)
    podcast.json   metadata the app reads: date, title, hosts, seconds, bytes, hash and per-turn
                   start times, so the app can highlight the line being spoken.

Google: HOST_A = en-US-Chirp3-HD-Kore, HOST_B = en-US-Chirp3-HD-Schedar. Plain text only (no SSML; AI, API, AWS go in as IPA customPronunciations), so all pauses
come from the silence this script inserts. No credentials are read here: the sandbox proxy adds the access token
for texttospeech.googleapis.com. Only Chirp 3 HD voices are accepted, so a paid voice can never be used by accident.

Kokoro voices: HOST_A = Alice = af_heart 70% + af_bella 30%, HOST_B = Michael = bm_fable
(blends of Kokoro voice styles; override with --voice-a / --voice-b or PODCAST_VOICE_A / PODCAST_VOICE_B,
for example --voice-b am_michael for the plain voice).
Models are downloaded once into --models (default ~/.cache/tldr-kokoro).

--style natural (default) paces each line by what it is (questions and reactions a little quicker, action
advice a little slower), uses short pauses after questions and longer ones before a new topic, lets short
reactions land slightly over the end of the previous line, evens out loudness and trims dead air.
--style plain is the old flat delivery. Everything is deterministic: the same script gives the same audio.

Usage: python3 scripts/podcast/synth.py --script script.txt --out /tmp/podcast-out --date 2026-10-19
"""
import argparse, base64, datetime, hashlib, json, os, re, shutil, subprocess, sys, time, urllib.request

MODEL_BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
MODEL_FILES = {"kokoro-v1.0.onnx": 300_000_000, "voices-v1.0.bin": 20_000_000}   # minimum plausible sizes
VOICES = {"A": "af_heart:0.7,af_bella:0.3", "B": "bm_fable"}   # blends: name:weight,name:weight
NAMES = {"A": "Alice", "B": "Michael"}
RATE = 24000
LEAD, TURN_GAP, CHUNK_GAP, TAIL = 0.25, 0.45, 0.12, 0.6      # seconds of silence
MAX_CHUNK_CHARS = 280
GOOGLE_URL = "https://texttospeech.googleapis.com/v1/text:synthesize"
GOOGLE_VOICES = {"A": "en-US-Chirp3-HD-Kore", "B": "en-US-Chirp3-HD-Schedar"}
GOOGLE_ALLOWED = ("Chirp3-HD",)   # the free-allowance voice family; Studio, Chirp HD and Polyglot are paid
GOOGLE_DEADLINE = 330              # seconds; past this Google is abandoned so the Kokoro fallback still fits the routine's time limit
START = time.time()
REACT_START = re.compile(r"^(right|exactly|absolutely|totally|definitely|true|fair point|good point|agreed|got it|wow|oh|okay|ok|sure|really|yes)\b", re.I)
TOPIC_START = re.compile(r"^(next|now|on the|let's|quick-fire|one more|finally|and now|moving|switching|turning|meanwhile|speaking of|before we)\b", re.I)
ACTION_WORDS = re.compile(r"\b(rotate|patch|revoke|update|upgrade|audit|block|lock down|make sure|need to)\b", re.I)
HERE = os.path.dirname(os.path.abspath(__file__))


def die(msg, code=1):
    print("synth: " + msg, file=sys.stderr)
    sys.exit(code)


def parse_script(path):
    turns = []
    with open(path, encoding="utf-8") as f:
        for n, raw in enumerate(f, 1):
            line = raw.strip()
            if not line:
                continue
            m = re.match(r"^HOST_([AB]):\s*(.+)$", line)
            if not m:
                die(f"{path}:{n}: expected 'HOST_A: ...' or 'HOST_B: ...'")
            turns.append((m.group(1), m.group(2).strip()))
    if not turns:
        die("script has no turns")
    return turns


def load_pronounce():
    with open(os.path.join(HERE, "pronounce.json"), encoding="utf-8") as f:
        data = json.load(f)
    return {k: v for k, v in data.items() if not k.startswith("_")}


def load_ipa():
    with open(os.path.join(HERE, "pronounce.json"), encoding="utf-8") as f:
        return json.load(f).get("_ipa", {})


def tts_clean(text, pron, skip=()):
    """Make text easier to speak. The displayed transcript keeps the original text."""
    t = re.sub(r"https?://\S+", "", text)
    t = re.sub(r"[*_`#\[\]]", "", t)
    t = t.replace("&", " and ")
    # longest keys first so "CI/CD" wins over "CI"
    for key in sorted((k for k in pron if k not in skip), key=len, reverse=True):
        t = re.sub(r"(?<![A-Za-z0-9])" + re.escape(key) + r"(?![A-Za-z0-9])", pron[key], t)
    # A lone "A" before another spelled letter is read as the article ("uh P I"); "Eigh" is read as the letter A.
    t = re.sub(r"(?<![A-Za-z'\u2019])A(?= [A-Z](?![A-Za-z]))", "Eigh", t)
    return re.sub(r"\s+", " ", t).strip()


def split_chunks(text, limit=MAX_CHUNK_CHARS):
    """Split at sentence ends so each chunk stays well under Kokoro's phoneme limit."""
    sentences = re.split(r"(?<=[.!?])\s+", text)
    chunks, cur = [], ""
    for s in sentences:
        if cur and len(cur) + 1 + len(s) > limit:
            chunks.append(cur)
            cur = s
        else:
            cur = (cur + " " + s).strip()
    if cur:
        chunks.append(cur)
    out = []
    for c in chunks:                       # a single very long sentence: split at commas, then at spaces
        while len(c) > limit:
            cut = c.rfind(",", 0, limit)
            cut = cut if cut > 60 else c.rfind(" ", 0, limit)
            out.append(c[:cut + 1].strip())
            c = c[cut + 1:].strip()
        out.append(c)
    return [c for c in out if c]


def split_sentences(text):
    """One chunk per sentence, so each sentence gets its own pace and pause; very long ones fall back to split_chunks."""
    out = []
    for sent in re.split(r"(?<=[.!?])\s+", text):
        if sent:
            out += split_chunks(sent) if len(sent) > MAX_CHUNK_CHARS else [sent]
    return out


def _j(key, amp):
    """Deterministic jitter in [-amp, amp] from a text key, so the same script always sounds the same."""
    return (int(hashlib.sha1(key.encode("utf-8")).hexdigest()[:8], 16) / 0xFFFFFFFF * 2 - 1) * amp


def plan_turns(turns, base_speed=1.0, natural=True, overlap_scale=1.0):
    """Decide pace, pause and overlap per turn. Pure python, no audio.
    Returns one dict per turn: speed, gap_after (silence before the next turn) and overlap_next
    (seconds the next turn starts before this one ends; then gap_after is 0)."""
    n, plan, last_overlap = len(turns), [], False
    for i, (h, text) in enumerate(turns):
        words, q = len(text.split()), text.rstrip().endswith("?")
        if not natural:
            plan.append({"speed": base_speed, "gap_after": TURN_GAP, "overlap_next": 0.0})
            continue
        sp = 1.0
        if REACT_START.search(text) and words <= 12:
            sp = 0.90                    # a reaction ("Exactly, that is the part to watch.") sounds better a touch slower
        elif q and words <= 12:
            sp = 1.05
        elif words <= 6:
            sp = 1.07
        elif words >= 10 and ACTION_WORDS.search(text):
            sp = 0.96
        sp = min(1.15, max(0.85, (sp + _j("t" + text, 0.01 if sp == 0.90 else 0.02)) * base_speed))
        gap, ov = 0.40 + _j("g" + text, 0.08), 0.0
        if i + 1 < n:
            nxt = turns[i + 1][1]
            nwords = len(nxt.split())
            short_react = nwords <= 10 and not nxt.rstrip().endswith("?")
            if q:
                gap = 0.20 + _j("q" + text, 0.03)
            elif TOPIC_START.search(nxt):
                gap = 0.80
            elif short_react and words >= 8 and not last_overlap and 0 < i and i + 2 < n and overlap_scale > 0:
                react = bool(REACT_START.search(nxt))
                if react or _j("p" + nxt, 0.5) + 0.5 < 0.6:      # reactions always, other short lines most of the time
                    ov = (0.10 + (_j("o" + nxt, 0.5) + 0.5) * 0.14 + (0.05 if react else 0.0)) * overlap_scale
                    gap = 0.0
                else:
                    gap = 0.22
            elif short_react:
                gap = 0.22
        last_overlap = ov > 0
        plan.append({"speed": sp, "gap_after": gap, "overlap_next": ov})
    return plan


def chunk_pace(chunk, idx, count, turn_speed, natural):
    """Sentence level pace and the pause after the sentence."""
    if not natural:
        return turn_speed, CHUNK_GAP
    q = chunk.rstrip().endswith("?")
    sp = turn_speed + (0.03 if q else 0.0) - (0.02 if idx == count - 1 and count > 1 else 0.0)
    gap = (0.22 if q else 0.16) + _j("c" + chunk, 0.03)
    return min(1.15, max(0.85, sp)), gap


def parse_voice(spec):
    """'af_heart' or 'am_michael:0.6,am_adam:0.4' -> [(name, weight), ...]"""
    out = []
    for part in [p.strip() for p in spec.split(",") if p.strip()]:
        name, _, w = part.partition(":")
        try:
            out.append((name.strip(), float(w) if w else 1.0))
        except ValueError:
            die(f"bad voice weight in '{part}'")
    if not out or any(wt <= 0 for _, wt in out):
        die(f"bad voice spec '{spec}'")
    return out


def ensure_models(models_dir):
    os.makedirs(models_dir, exist_ok=True)
    for name, min_size in MODEL_FILES.items():
        dest = os.path.join(models_dir, name)
        if os.path.exists(dest) and os.path.getsize(dest) >= min_size:
            continue
        last = None
        for attempt in range(1, 5):
            try:
                print(f"synth: downloading {name} (attempt {attempt})", flush=True)
                tmp = dest + ".part"
                with urllib.request.urlopen(f"{MODEL_BASE}/{name}", timeout=120) as r, open(tmp, "wb") as f:
                    shutil.copyfileobj(r, f, 1 << 20)
                if os.path.getsize(tmp) < min_size:
                    raise IOError(f"{name} is too small ({os.path.getsize(tmp)} bytes)")
                os.replace(tmp, dest)
                last = None
                break
            except Exception as e:          # noqa: BLE001 - retry any network or size error
                last = e
                time.sleep(2 ** attempt)
        if last is not None:
            die(f"could not download {name}: {last}")
    return (os.path.join(models_dir, "kokoro-v1.0.onnx"), os.path.join(models_dir, "voices-v1.0.bin"))


SPEC_BANDS, SPEC_FPS = 16, 10


def compute_spectrum(samples, rate=RATE, fps=SPEC_FPS, bands=SPEC_BANDS, fmin=80.0, fmax=8000.0):
    """Spectrum frames for the app's analyzer, computed from the real audio.

    Returns base64 of uint8 values, frames x bands, row-major: one frame every 1/fps seconds, `bands`
    log-spaced bands from fmin to fmax. Values are scaled per episode (the loud parts reach 255) with a
    gentle tilt so the treble of speech is visible. Silence stays at 0.
    """
    import numpy as np
    x = np.asarray(samples, dtype=np.float32)
    hop, win = int(rate // fps), 2048
    n_frames = int(np.ceil(len(x) / hop))
    pad = np.concatenate([x, np.zeros(n_frames * hop + win - len(x), dtype=np.float32)])
    window = np.hanning(win).astype(np.float32)
    freqs = np.fft.rfftfreq(win, 1.0 / rate)
    edges = np.geomspace(fmin, fmax, bands + 1)
    spans = []
    for i in range(bands):
        a = int(np.searchsorted(freqs, edges[i]))
        b = max(int(np.searchsorted(freqs, edges[i + 1])), a + 1)
        spans.append((a, b))
    db = np.zeros((n_frames, bands), dtype=np.float32)
    for f in range(n_frames):
        centre = f * hop
        seg = pad[centre:centre + win] * window
        mag = np.abs(np.fft.rfft(seg))
        for i, (a, b) in enumerate(spans):
            db[f, i] = 20.0 * np.log10(float(mag[a:b].mean()) + 1e-6)
    db += np.linspace(0.0, 9.0, bands, dtype=np.float32)          # speech energy falls with frequency
    active = db[db > db.min() + 1.0]
    ref = float(np.percentile(active, 97)) if active.size else float(db.max())
    scaled = np.clip((db - (ref - 42.0)) / 42.0, 0.0, 1.0)
    quiet = np.abs(pad[:n_frames * hop].reshape(n_frames, hop)).max(axis=1) < 1e-4   # true silence stays dark
    scaled[quiet] = 0.0
    return base64.b64encode((scaled * 255.0).astype(np.uint8).tobytes()).decode("ascii")


def ffprobe_seconds(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                       capture_output=True, text=True)
    if r.returncode != 0:
        die("ffprobe failed: " + r.stderr.strip())
    return float(r.stdout.strip())


def google_create(text, voice, speed, sf, ipa=None):
    """One Cloud Text-to-Speech request, plain text. No credentials here: the sandbox proxy adds the token for this host.
    Pace is applied afterwards with ffmpeg atempo.
    Rate limits and server errors are retried; anything else (quota, permission, billing, blocked host) stops at once."""
    import io, urllib.error
    inp = {"text": text}
    hits = [{"phrase": k, "phoneticEncoding": "PHONETIC_ENCODING_IPA", "pronunciation": v} for k, v in (ipa or {}).items()
            if re.search(r"(?<![A-Za-z0-9])" + re.escape(k) + r"(?![A-Za-z0-9])", text)]
    if hits:
        inp["customPronunciations"] = {"pronunciations": hits}
    body = json.dumps({"input": inp, "voice": {"languageCode": "en-US", "name": voice},
                       "audioConfig": {"audioEncoding": "LINEAR16", "sampleRateHertz": RATE}}).encode()
    for attempt in range(6):
        try:
            req = urllib.request.Request(GOOGLE_URL, body, {"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=60) as r:
                wav = base64.b64decode(json.load(r)["audioContent"])
            break
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504) or attempt == 5 or time.time() - START > GOOGLE_DEADLINE:
                die(f"google tts failed: HTTP {e.code} {e.read()[:200].decode(errors='replace')}")
            wait = 15 * (attempt + 1) if e.code == 429 else 2 ** attempt     # a per-minute quota needs a real pause
            print(f"synth: google HTTP {e.code}, waiting {wait}s (try {attempt + 2}/6)", file=sys.stderr, flush=True)
            time.sleep(wait)
        except Exception as e:                      # network blip or blocked host
            if attempt == 5:
                die(f"google tts failed: {e}")
            time.sleep(2 ** attempt)
    if abs(speed - 1.0) > 0.005:
        r = subprocess.run(["ffmpeg", "-loglevel", "error", "-f", "wav", "-i", "pipe:0", "-filter:a", f"atempo={speed:.3f}",
                            "-f", "wav", "pipe:1"], input=wav, capture_output=True)
        if r.returncode:
            die("ffmpeg atempo failed: " + r.stderr.decode().strip())
        wav = r.stdout
    return sf.read(io.BytesIO(wav), dtype="float32")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--script", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--date", required=True, help="edition date, YYYY-MM-DD")
    ap.add_argument("--bitrate", default=os.environ.get("PODCAST_BITRATE", "128k"))
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--style", choices=["natural", "plain"], default=os.environ.get("PODCAST_STYLE", "natural"))
    ap.add_argument("--overlap", type=float, default=1.0, help="0 turns overlapping off, 1 is normal, 1.5 is more")
    ap.add_argument("--engine", choices=["kokoro", "google"], default=os.environ.get("PODCAST_ENGINE", "kokoro"))
    ap.add_argument("--voice-a", default=os.environ.get("PODCAST_VOICE_A"))
    ap.add_argument("--voice-b", default=os.environ.get("PODCAST_VOICE_B"))
    ap.add_argument("--limit-turns", type=int, default=0, help="only the first N turns (for voice samples)")
    ap.add_argument("--models", default=os.path.expanduser("~/.cache/tldr-kokoro"))
    a = ap.parse_args()

    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", a.date):
        die("--date must be YYYY-MM-DD")
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        die("ffmpeg and ffprobe are required")
    google = a.engine == "google"
    names = GOOGLE_VOICES if google else VOICES
    a.voice_a, a.voice_b = a.voice_a or names["A"], a.voice_b or names["B"]
    if google:
        for v in (a.voice_a, a.voice_b):
            if not any(t in v for t in GOOGLE_ALLOWED):
                die(f"voice '{v}' is not an allowed Google voice {GOOGLE_ALLOWED}; other Google voices are paid")
    try:
        import numpy as np
        import soundfile as sf
        if not google:
            from kokoro_onnx import Kokoro
    except ImportError as e:
        die(f"missing python package ({e}). Run: python3 -m pip install --break-system-packages kokoro-onnx soundfile")

    turns = parse_script(a.script)
    pron = load_pronounce()
    ipa = load_ipa() if google else {}
    os.makedirs(a.out, exist_ok=True)

    t0 = time.time()
    if not google:
        model, voices = ensure_models(a.models)
        kokoro = Kokoro(model, voices)
    natural = a.style == "natural"

    def resolve(spec):
        items = parse_voice(spec)
        known = set(kokoro.get_voices())
        for nm, _ in items:
            if nm not in known:
                die(f"unknown voice '{nm}'. Available: " + ", ".join(sorted(known)))
        if len(items) == 1:
            return items[0][0]
        tot = sum(w for _, w in items)
        return sum(kokoro.get_voice_style(nm) * (w / tot) for nm, w in items).astype(np.float32)

    voice_of = {"A": a.voice_a, "B": a.voice_b} if google else {"A": resolve(a.voice_a), "B": resolve(a.voice_b)}
    if a.limit_turns:
        turns = turns[:a.limit_turns]
    plan = plan_turns(turns, a.speed, natural, a.overlap)

    def edge(x):
        """Trim dead air at both ends and fade 8 ms so joins never click."""
        if natural:
            idx = np.flatnonzero(np.abs(x) > 0.008)
            if len(idx):
                pad = int(0.02 * RATE)
                x = x[max(0, idx[0] - pad): idx[-1] + pad + 1]
            f = int(0.008 * RATE)
            if len(x) > 2 * f:
                x = x.copy()
                x[:f] *= np.linspace(0, 1, f, dtype=np.float32)
                x[-f:] *= np.linspace(1, 0, f, dtype=np.float32)
        return x

    gap = lambda s: np.zeros(int(s * RATE), dtype=np.float32)   # noqa: E731
    buf, cursor, segments = gap(LEAD), int(LEAD * RATE), []
    for i, (h, text) in enumerate(turns, 1):
        clean = tts_clean(text, pron, skip=ipa)
        chunks = split_sentences(clean) if natural else split_chunks(clean)
        turn_audio = []
        for j, chunk in enumerate(chunks):
            sp, cgap = chunk_pace(chunk, j, len(chunks), plan[i - 1]["speed"], natural)
            if google:
                samples, sr = google_create(chunk, voice_of[h], sp, sf, ipa)
            else:
                samples, sr = kokoro.create(chunk, voice=voice_of[h], speed=sp, lang="en-us")
            if sr != RATE:
                die(f"unexpected sample rate {sr}")
            samples = edge(samples.astype(np.float32))
            if float(np.sqrt((samples ** 2).mean())) < 1e-4:
                die(f"turn {i} chunk {j + 1} came out silent")
            turn_audio.append(samples)
            if j < len(chunks) - 1:
                turn_audio.append(gap(cgap))
        audio = np.concatenate(turn_audio)
        if natural:                                     # same loudness for every turn and both hosts
            rms = float(np.sqrt((audio ** 2).mean()))
            audio = audio * min(1.6, max(0.7, 0.09 / max(rms, 1e-6)))
        if i == 1:
            start = cursor
        else:
            prev = plan[i - 2]
            if prev["overlap_next"] > 0:                # land over the tail of the previous line
                ov = min(int(prev["overlap_next"] * RATE), int(len(audio) * 0.6), cursor - int(0.5 * RATE))
                start = cursor - ov
                buf[start:cursor] *= np.linspace(1.0, 0.55, cursor - start, dtype=np.float32)
            else:
                start = cursor + int(prev["gap_after"] * RATE)
        if len(buf) < start + len(audio):
            buf = np.concatenate([buf, np.zeros(start + len(audio) - len(buf), dtype=np.float32)])
        buf[start:start + len(audio)] += audio
        cursor = start + len(audio)
        segments.append({"h": h, "t": text, "s": round(start / RATE, 2)})
        print(f"synth: turn {i}/{len(turns)} done ({time.time() - t0:.0f}s elapsed)", flush=True)
    parts = [buf, gap(TAIL)]
    peak = float(np.max(np.abs(buf))) if len(buf) else 0.0
    if natural and peak > 0.95:
        parts = [buf * (0.95 / peak), gap(TAIL)]

    full = np.concatenate(parts)
    spec = compute_spectrum(full)
    wav = os.path.join(a.out, "latest.wav")
    mp3 = os.path.join(a.out, "latest.mp3")
    sf.write(wav, full, RATE)
    d = datetime.date.fromisoformat(a.date)
    title = f"TL;DR Daily · {d.strftime('%a %b')} {d.day}"
    norm = ["-af", "loudnorm=I=-18:TP=-1.5:LRA=9"] if natural else []      # podcast-level loudness, no clipping
    r = subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", wav, *norm, "-ac", "1", "-ar", "44100",
                        "-codec:a", "libmp3lame", "-b:a", a.bitrate,
                        "-metadata", f"title={title}", "-metadata", "artist=Alice and Michael",
                        "-metadata", f"album=TL;DR Daily", "-metadata", f"date={a.date}", mp3],
                       capture_output=True, text=True)
    if r.returncode != 0:
        die("ffmpeg failed: " + r.stderr.strip())
    os.remove(wav)

    with open(mp3, "rb") as f:
        data = f.read()
    seconds = round(ffprobe_seconds(mp3), 1)
    meta = {
        "version": 1,
        "date": a.date,
        "title": title,
        "hosts": {"A": NAMES["A"], "B": NAMES["B"]},
        "file": "latest.mp3",
        "seconds": seconds,
        "bytes": len(data),
        "bitrate": int(re.sub(r"\D", "", a.bitrate)) * 1000,
        "hash": hashlib.sha1(data).hexdigest()[:12],
        "words": sum(len(t.split()) for _, t in turns),
        "segments": segments,
        "specBands": SPEC_BANDS,
        "specFps": SPEC_FPS,
        "spec": spec,
    }
    with open(os.path.join(a.out, "podcast.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    print(f"synth: wrote {mp3} ({seconds / 60:.1f} min, {len(data) / 1e6:.1f} MB, {meta['words']} words) in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
