#!/usr/bin/env python3
"""Build data/router.json from the public SPROUT routing data (fetched by
scripts/fetch_sprout.py). Stdlib only, deterministic.

1. Keep 5 models from SPROUT (4 cheaper candidates + gpt-4o as the premium model).
2. Split SPROUT 'validation' rows by key hash into a router-training half and a
   calibration half; SPROUT 'test' rows are the held-out test set.
3. Train one logistic regression per cheaper model (hashed prompt words and
   bigrams + task family + length bucket) predicting "this model's judge score
   is at least the premium model's score". This stands in for the production
   router's own confidence score.
4. Write only calibration + test rows (scores, tokens, predicted probabilities)
   plus a few prompt previews for the decision log.
"""
import json, math, random, sys, zlib, os

SRC = sys.argv[1] if len(sys.argv) > 1 else "/tmp/sprout_compact.jsonl"
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "router.json")

# (SPROUT key, display name, $/M input, $/M output, source)
MODELS = [
    ("wxai-llama-3-2-3b-instruct", "llama-3.2-3b", 0.06, 0.06, "Together AI list price (Llama 3.2 3B Instruct Turbo)"),
    ("wxai-llama-3-1-8b-instruct", "llama-3.1-8b", 0.18, 0.18, "Together AI list price (Llama 3.1 8B Instruct Turbo)"),
    ("openai-gpt-4o-mini", "gpt-4o-mini", 0.15, 0.60, "OpenAI list price"),
    ("wxai-llama-3-3-70b-instruct", "llama-3.3-70b", 0.88, 0.88, "Together AI list price (Llama 3.3 70B Instruct Turbo)"),
    ("openai-gpt-4o", "gpt-4o", 2.50, 10.00, "OpenAI list price"),
]
FAMILIES = ["General assistant", "Knowledge Q&A", "Math", "Multi-step reasoning", "Document Q&A (RAG)"]

def family(task):
    t = task.lower()
    if "openhermes" in t: return 0
    if "mmlu" in t or "gpqa" in t: return 1
    if "math" in t: return 2
    if "musr" in t: return 3
    if "ragbench" in t: return 4
    return None

NB = 4096
def bucket(ntok):
    return min(7, int(math.log2(max(1, ntok)) // 1.5))

NL = 256
def featurize(r):
    f = list(r["f"])
    f.append(NB + r["fam"])
    f.append(NB + len(FAMILIES) + bucket(r["ntok"]))
    f.append(NB + len(FAMILIES) + 8 + zlib.crc32((r["task"] + "|" + str(r["level"])).encode()) % NL)  # sub-task / difficulty level
    return f
DIM = NB + len(FAMILIES) + 8 + NL

def h01(key):
    return (zlib.crc32(key.encode()) % 1000) / 1000.0

rows = []
for line in open(SRC):
    d = json.loads(line)
    fam = family(d["task"])
    if fam is None: continue
    m = d["m"]
    if any(k not in m or m[k][0] is None or m[k][1] is None or m[k][2] is None for k, *_ in MODELS):
        continue
    d["fam"] = fam
    d["part"] = 2 if d["split"] == "test" else (0 if h01(d["key"]) < 0.5 else 1)  # 0 train, 1 calibration, 2 test
    rows.append(d)

P = len(MODELS) - 1
def sc(d, k): return d["m"][MODELS[k][0]][0]

# ---- logistic regression (AdaGrad SGD, L2) per cheaper model ----
def train(target_k):
    w = [0.0] * (DIM + 1)
    g2 = [1e-8] * (DIM + 1)
    data = [(featurize(d), 1.0 if sc(d, target_k) >= sc(d, P) else 0.0) for d in rows if d["part"] == 0]
    rnd = random.Random(1000 + target_k)
    lr, l2 = 0.05, 2e-3
    for ep in range(4):
        rnd.shuffle(data)
        for f, y in data:
            z = w[DIM] + sum(w[j] for j in f)
            p = 1 / (1 + math.exp(-max(-30, min(30, z))))
            g = p - y
            for j in f:
                gj = g + l2 * w[j]
                g2[j] += gj * gj
                w[j] -= lr * gj / math.sqrt(g2[j])
            g2[DIM] += g * g
            w[DIM] -= lr * g / math.sqrt(g2[DIM])
    return w

def predict(w, d):
    z = w[DIM] + sum(w[j] for j in featurize(d))
    return 1 / (1 + math.exp(-max(-30, min(30, z))))

def auc(scores, labels):
    pos = [s for s, y in zip(scores, labels) if y]; neg = [s for s, y in zip(scores, labels) if not y]
    if not pos or not neg: return None
    allv = sorted([(s, 1) for s in pos] + [(s, 0) for s in neg])
    rank_sum, i = 0.0, 0
    while i < len(allv):
        j = i
        while j < len(allv) and allv[j][0] == allv[i][0]: j += 1
        avg = (i + j + 1) / 2
        rank_sum += avg * sum(1 for t in range(i, j) if allv[t][1] == 1)
        i = j
    return (rank_sum - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg))

weights = [train(k) for k in range(P)]
keep = [d for d in rows if d["part"] in (1, 2)]
keep.sort(key=lambda d: (d["part"], d["key"]))
diag = []
for k in range(P):
    cal = [d for d in keep if d["part"] == 1]
    ps = [predict(weights[k], d) for d in cal]
    ys = [sc(d, k) >= sc(d, P) for d in cal]
    base = sum(ys) / len(ys)
    diag.append({"model": MODELS[k][1], "calAUC": round(auc(ps, ys), 4), "baseRate": round(base, 4)})

R = {"split": [], "fam": [], "s": [[] for _ in MODELS], "tin": [[] for _ in MODELS], "tout": [[] for _ in MODELS], "p": [[] for _ in range(P)]}
for d in keep:
    R["split"].append(0 if d["part"] == 1 else 1)
    R["fam"].append(d["fam"])
    for k, (key, *_) in enumerate(MODELS):
        s, ti, to = d["m"][key]
        R["s"][k].append(int(round(s * 100)))
        R["tin"][k].append(int(ti)); R["tout"][k].append(int(to))
    for k in range(P):
        R["p"][k].append(int(round(predict(weights[k], d) * 10000)))

rnd = random.Random(7)
samples = []
for idx in sorted(rnd.sample(range(len(keep)), 360)):
    d = keep[idx]
    samples.append({"i": idx, "task": d["task"].split("/")[-1] if "ragbench" in d["task"] else d["task"].split("/")[0].replace("TIGER-Lab", "MMLU-Pro").replace("lighteval", "MATH").replace("openhermes", "OpenHermes").replace("TAUR-Lab", "MuSR").replace("Idavidrein", "GPQA"), "preview": " ".join(d["preview"].split())[:200]})

out = {
    "meta": {"source": "SPROUT (CARROT-LLM-Routing/SPROUT on Hugging Face; Somerstep et al., 2025): validation and test splits, judge scores and token counts per model", "fetched_by": "scripts/fetch_sprout.py", "built_by": "scripts/build_data.py",
             "rows": {"train_router": sum(1 for d in rows if d["part"] == 0), "calibration": sum(1 for d in keep if d["part"] == 1), "test": sum(1 for d in keep if d["part"] == 2)},
             "router": "logistic regression per cheaper model on hashed prompt words/bigrams + task family + length; target: judge score >= gpt-4o's", "diagnostics": diag},
    "families": FAMILIES,
    "models": [{"id": key, "name": name, "price": [pin, pout], "priceSource": src, "premium": k == P} for k, (key, name, pin, pout, src) in enumerate(MODELS)],
    "rows": R,
    "samples": samples,
}
json.dump(out, open(OUT, "w"), separators=(",", ":"))
print(json.dumps(out["meta"], indent=1))
print("bytes", os.path.getsize(OUT))
