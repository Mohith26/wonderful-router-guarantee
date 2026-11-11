#!/usr/bin/env python3
"""Fetch the public SPROUT routing dataset (CARROT-LLM-Routing/SPROUT, Hugging Face)
validation + test splits through the datasets-server rows API and keep only what
the router needs: task, prompt length, hashed prompt tokens, a short prompt
preview, and per-model judge score + token counts. Output: /tmp/sprout_compact.jsonl
(not committed; scripts/build_data.py turns it into data/router.json)."""
import json, re, sys, time, urllib.request, zlib

BASE = "https://datasets-server.huggingface.co/rows?dataset=CARROT-LLM-Routing%2FSPROUT&config=default&split={split}&offset={off}&length={ln}"
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/sprout_compact.jsonl"
NB = 4096
tok = re.compile(r"[a-z0-9]+")

def feats(text):
    t = tok.findall(text.lower())
    ids = set()
    for w in t:
        ids.add(zlib.crc32(w.encode()) % NB)
    for a, b in zip(t, t[1:]):
        ids.add(zlib.crc32((a + "_" + b).encode()) % NB)
    return sorted(ids)[:400], len(t)

def get(url, tries=4):
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "router-guarantee-research (github.com/Mohith26)"}), timeout=60) as r:
                return json.loads(r.read())
        except Exception:
            time.sleep(2 + 2 * k)
    raise RuntimeError("failed " + url)

def page(split, off, ln):
    """rows [off, off+ln); falls back to smaller pages when the API errors (skips rows that never load)"""
    try:
        return get(BASE.format(split=split, off=off, ln=ln))["rows"], []
    except RuntimeError:
        if ln == 1:
            return [], [(split, off)]
        sub = max(1, ln // 5)
        rows, skipped = [], []
        for o in range(off, off + ln, sub):
            r, s_ = page(split, o, sub)
            rows += r; skipped += s_
        return rows, skipped

# resumable: count rows already written per split
done = {"validation": 0, "test": 0}
try:
    for l in open(OUT):
        done[json.loads(l)["split"]] += 1
except FileNotFoundError:
    pass
n = sum(done.values()); skipped_all = []
with open(OUT, "a") as f:
    for split, total in (("validation", 6636), ("test", 6637)):
        for off in range(done[split], total, 100):
            rows, skipped = page(split, off, min(100, total - off))
            skipped_all += skipped
            for row in rows:
                r = row["row"]
                ids, ntok = feats(r["prompt"] or "")
                models = {k: [v.get("score"), v.get("num_input_tokens"), v.get("num_output_tokens")] for k, v in r.items() if isinstance(v, dict) and "score" in v}
                f.write(json.dumps({"split": split, "key": r["key"], "task": r["dataset"], "level": r["dataset_level"], "ntok": ntok, "f": ids, "preview": (r["prompt"] or "")[:220], "m": models}) + "\n")
                n += 1
            f.flush()
            time.sleep(0.3)
            print(split, off, n, "skipped", len(skipped_all), flush=True)
print("rows", n, "skipped", skipped_all)
