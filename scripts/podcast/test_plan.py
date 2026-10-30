#!/usr/bin/env python3
"""Checks the pacing plan and voice parsing in synth.py. Pure python, needs no audio libraries. Exit 0 pass, 1 fail."""
import os, runpy, sys
ns = runpy.run_path(os.path.join(os.path.dirname(os.path.abspath(__file__)), "synth.py"), run_name="lib")
plan_turns, chunk_pace, parse_voice, split_sentences = ns["plan_turns"], ns["chunk_pace"], ns["parse_voice"], ns["split_sentences"]
fails = 0
def check(name, cond, extra=""):
    global fails
    print(("ok   " if cond else "FAIL ") + name + ("  " + str(extra) if extra else ""))
    fails += 0 if cond else 1

LONG = "This is a long explanation with plenty of words so that the next short reaction can land over its tail end."
T = [("A", "Welcome to the show, today we cover a few stories."), ("B", "Thanks, and here is the first big one for you today."),
     ("A", LONG), ("B", "Right."), ("A", LONG), ("B", "Exactly."), ("A", "Is that all of it?"), ("B", LONG + " More detail follows here."),
     ("A", "Next, a database story."), ("B", LONG), ("A", "Thanks for listening. I'm Alice."), ("B", "And I'm Michael.")]
p = plan_turns(T)
check("one plan entry per turn", len(p) == len(T))
check("a short reaction after a long line overlaps it", p[2]["overlap_next"] > 0 and p[2]["gap_after"] == 0, p[2])
check("overlap stays small (under 0.35 s)", all(x["overlap_next"] < 0.35 for x in p))
check("never two overlaps in a row", all(not (p[i]["overlap_next"] > 0 and p[i + 1]["overlap_next"] > 0) for i in range(len(p) - 1)))
check("no overlap into the opening or the sign-off", p[0]["overlap_next"] == 0 and p[1]["overlap_next"] == 0 and p[-2]["overlap_next"] == 0 and p[-3]["overlap_next"] == 0)
check("a question is answered quickly", p[6]["gap_after"] < 0.3 and p[6]["overlap_next"] == 0, p[6])
check("a new topic gets a longer pause", p[7]["gap_after"] >= 0.7, p[7])
check("speeds stay in a natural range", all(0.85 <= x["speed"] <= 1.15 for x in p))
check("plan is deterministic", plan_turns(T) == p)
check("overlap 0 switches overlapping off", all(x["overlap_next"] == 0 for x in plan_turns(T, overlap_scale=0)))
q = plan_turns([("A", LONG), ("B", "Okay.")] * 3)
flat = plan_turns(T, natural=False)
check("plain style is the old flat delivery", all(x["speed"] == 1.0 and x["gap_after"] == 0.45 and x["overlap_next"] == 0 for x in flat))
check("a question sentence is a touch quicker, the last sentence settles", chunk_pace("Really?", 0, 2, 1.0, True)[0] > chunk_pace("Fine.", 1, 2, 1.0, True)[0])
check("questions pause a little longer than statements", chunk_pace("Really?", 0, 2, 1.0, True)[1] > chunk_pace("Fine.", 0, 2, 1.0, True)[1] - 0.06)
check("one chunk per sentence", split_sentences("One is here. Two is here? Three is here!") == ["One is here.", "Two is here?", "Three is here!"])
check("voice blend is parsed", parse_voice("am_michael:0.6,am_adam:0.4") == [("am_michael", 0.6), ("am_adam", 0.4)])
check("a single voice has weight 1", parse_voice("af_heart") == [("af_heart", 1.0)])
pr, tc = ns["load_pronounce"](), ns["tts_clean"]
check("spelled A P I is spoken with a letter A", tc("the A P I keys", pr) == "the Ay P I keys", tc("the A P I keys", pr))
check("A I and A W S are spoken with a letter A", tc("A I agents on A W S", pr) == "Ay I agents on Ay W S")
check("the word API is spoken with a letter A", tc("the API and APIs", pr) == "the Ay Pee Eye and Ay Pee Eyes")
check("the article A is left alone", tc("A new ransomware and A Postgres bug", pr) == "A new ransomware and A Postgres bug")
check("names with an A are left alone", tc("Alice and Anthropic", pr) == "Alice and Anthropic")
check("Hm is spoken as a hum, not the letters H M", tc("Hm, that is odd. And hm, maybe. Mm, right.", pr) == "Hmm, that is odd. And hmm, maybe. Hmm, right.", tc("Hm, that is odd. And hm, maybe. Mm, right.", pr))
check("Hmm and Home are left alone", tc("Hmm, home and Hammer", pr) == "Hmm, home and Hammer")
R = plan_turns([("A", LONG), ("B", "Exactly, that is the part to watch."), ("A", LONG), ("B", "Absolutely."), ("A", LONG), ("B", "Okay, so what do I do today?")])
check("reactions like Exactly and Absolutely are spoken at about 0.9x", all(0.88 <= R[i]["speed"] <= 0.92 for i in (1, 3)), [round(R[i]["speed"], 3) for i in (1, 3)])
check("a long explanation is not slowed to reaction pace", all(R[i]["speed"] > 0.93 for i in (0, 2, 4)))
check("default voices are the chosen blends", ns["VOICES"] == {"A": "af_heart:0.7,af_bella:0.3", "B": "bm_fable"})
sys.exit(1 if fails else 0)
