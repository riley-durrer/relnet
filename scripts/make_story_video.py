#!/usr/bin/env python3
"""Render the output of `npm run story` as a captioned video (no audio).
   python3 scripts/make_story_video.py story-output.txt relnet-story.mp4 [scene,keys,to,skip]
Markers in the transcript: @@title, @@scene key | actor | caption, @@pause, @@end. Everything else is terminal output."""
import re, subprocess, sys, textwrap, os, tempfile
from PIL import Image, ImageDraw, ImageFont

src, dst = sys.argv[1], sys.argv[2]
SKIP = set(sys.argv[3].split(",")) if len(sys.argv) > 3 else set()  # scene keys to leave out, e.g. buyer-download,supplier-setup
W, H = 1280, 720
BG, FG, DIM = (15, 18, 23), (232, 236, 242), (140, 150, 165)
GREEN, RED, BLUE, AMBER, VIOLET = (76, 196, 127), (255, 122, 112), (109, 155, 255), (229, 176, 74), (178, 140, 255)
F = "/usr/share/fonts/truetype/dejavu/"
MONO = ImageFont.truetype(F + "DejaVuSansMono.ttf", 18)
SANS = ImageFont.truetype(F + "DejaVuSans.ttf", 25)
BOLD = ImageFont.truetype(F + "DejaVuSans-Bold.ttf", 24)
BIG = ImageFont.truetype(F + "DejaVuSans-Bold.ttf", 58)
MID = ImageFont.truetype(F + "DejaVuSans.ttf", 28)
SMALL = ImageFont.truetype(F + "DejaVuSans.ttf", 17)
CW, LINE_H, TOP, BAND, CAP = 10.8, 24, 62, 44, 118
ROWS = (H - TOP - CAP - 10) // LINE_H
WRAP = int((W - 70) / CW)

scenes, title, cur = [], None, None
for raw in open(src, encoding="utf8").read().split("\n"):
    if raw.startswith("@@title"):
        title = [p.strip() for p in raw[8:].split("|")]
    elif raw.startswith("@@scene"):
        key, actor, caption = [p.strip() for p in raw[8:].split("|", 2)]
        cur = {"key": key, "actor": actor, "caption": caption, "lines": []}
        scenes.append(cur)
    elif raw.startswith("@@pause"):
        cur["lines"].append(("@pause", ""))
    elif raw.startswith("@@end"):
        break
    elif cur is not None and raw.strip() != "":
        cur["lines"].append(("raw", raw.rstrip()))

MONO_BIG = ImageFont.truetype(F + "DejaVuSansMono.ttf", 24)
for sc in scenes:
    n_raw = sum(1 for k, _ in sc["lines"] if k == "raw")
    big = n_raw <= 9  # few lines: show them larger
    sc["font"], sc["cw"], sc["lh"] = (MONO_BIG, 14.45, 32) if big else (MONO, CW, LINE_H)
    wrap = int((W - 70) / sc["cw"])
    out_lines = []
    for k, l in sc["lines"]:
        if k == "raw":
            for part in textwrap.wrap(l, wrap, subsequent_indent="    ", drop_whitespace=False) or [""]:
                out_lines.append(("line", part))
        else:
            out_lines.append((k, l))
    sc["lines"] = out_lines

def actor_color(a):
    a = a.upper()
    if "LONE STAR" in a: return BLUE
    if "TRINITY" in a: return AMBER
    if "AGENTS" in a or "ESCROW" in a or "NETWORK" in a: return GREEN
    return VIOLET

def line_color(l):
    s = l.lstrip()
    if s.startswith("lonestar$"): return BLUE
    if s.startswith("trinity$"): return AMBER
    if s.startswith("chain>"): return GREEN
    if s.startswith("agent>"): return VIOLET
    if s.startswith("·"): return DIM
    if "VERIFIED" in s and "NOT" not in s: return GREEN
    if re.match(r"^\s*(NOT VERIFIED|REFUSED|FAIL)", l) or "FAIL" in s[:8]: return RED
    if "NOT PINNED" in s or "INCOMPLETE" in s or "WARNING" in s: return AMBER
    return FG

def draw_line(d, y, l, font=MONO, cw=CW):
    col = line_color(l)
    m = re.match(r"^(\s*)(PASS|FAIL|SKIPPED)(\s.*)$", l)
    if m:
        pre, word, rest = m.groups()
        d.text((35, y), pre, font=font, fill=FG)
        wcol = {"PASS": GREEN, "FAIL": RED, "SKIPPED": AMBER}[word]
        d.text((35 + len(pre) * cw, y), word, font=font, fill=wcol)
        d.text((35 + (len(pre) + len(word)) * cw, y), rest, font=font, fill=FG)
        return
    for p in ("lonestar$", "trinity$", "chain>", "agent>"):
        if l.lstrip().startswith(p):
            ind = len(l) - len(l.lstrip())
            d.text((35, y), l[:ind + len(p)], font=font, fill=col)
            d.text((35 + (ind + len(p)) * cw, y), l[ind + len(p):], font=font, fill=FG)
            return
    d.text((35, y), l, font=font, fill=col)

def frame(scene, upto):
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    ac = actor_color(scene["actor"])
    d.rectangle([0, 0, W, BAND], fill=(24, 29, 37))
    d.rectangle([0, 0, 10, BAND], fill=ac)
    d.text((28, 8), scene["actor"], font=BOLD, fill=ac)
    d.text((W - 395, 14), "real run, time-compressed", font=SMALL, fill=AMBER)
    shown = [l for k, l in scene["lines"][: upto + 1] if k == "line"]
    y = TOP
    rows = (H - TOP - CAP - 10) // scene["lh"]
    for l in shown[-rows:]:
        draw_line(d, y, l, scene["font"], scene["cw"]); y += scene["lh"]
    d.rectangle([0, H - CAP, W, H], fill=(24, 29, 37))
    d.line([0, H - CAP, W, H - CAP], fill=(42, 49, 60), width=2)
    y = H - CAP + 12
    for part in textwrap.wrap(scene["caption"], 82)[:3]:
        d.text((36, y), part, font=SANS, fill=FG); y += 32
    return im

def card(lines, sizes, colors):
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    y = 150
    for text, font, col in zip(lines, sizes, colors):
        for part in textwrap.wrap(text, 52 if font is MID else 30 if font is BIG else 70):
            d.text((80, y), part, font=font, fill=col); y += font.size + 14
        y += 18
    return im

tmp = tempfile.mkdtemp()
entries = []  # (png, seconds)
n = 0
def add(im, sec):
    global n
    p = os.path.join(tmp, f"f{n:05d}.png"); n += 1
    im.save(p); entries.append((p, sec))

if title:
    add(card([title[0], title[1], title[2]], [BIG, MID, SANS], [FG, BLUE, DIM]), 3.0 if SKIP else 5.0)
scenes = [sc for sc in scenes if sc["key"] not in SKIP]
for sc in scenes:
    read = max(3.0, len(sc["caption"]) / 17.0)  # seconds to read the caption
    spent = 0.0
    lines = sc["lines"]
    if not lines:
        add(frame(sc, -1), read); continue
    for i, (k, l) in enumerate(lines):
        if k == "@pause":
            if entries: entries[-1] = (entries[-1][0], entries[-1][1] + 1.2); spent += 1.2
            continue
        is_cmd = bool(re.match(r"^\s*(lonestar\$|trinity\$)", l))
        sec = 1.1 if is_cmd else (0.9 if l.lstrip().startswith(("chain>", "agent>")) else 0.34)
        add(frame(sc, i), sec); spent += sec
    entries[-1] = (entries[-1][0], entries[-1][1] + max(2.0, read - spent))
end = [
    ("relnet v0.1.0", BIG, FG),
    ("Agents make the deal. People sign it. Contracts enforce it. No bank in the middle.", MID, BLUE),
    ("What this was: a local test network, test tokens, a simulated funding service, two companies on one computer. No fee saving is measured. Not audited.", SANS, AMBER),
    ("github.com/riley-durrer/relnet  ·  Apache-2.0", SANS, DIM),
]
add(card([e[0] for e in end], [e[1] for e in end], [e[2] for e in end]), 5.0 if SKIP else 8.0)

lst = os.path.join(tmp, "list.txt")
with open(lst, "w") as f:
    for p, s in entries:
        f.write(f"file '{p}'\nduration {s:.2f}\n")
    f.write(f"file '{entries[-1][0]}'\n")
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst, "-vf", "fps=15,format=yuv420p", "-c:v", "libx264", "-crf", "24", dst], check=True)
total = sum(s for _, s in entries)
print(f"{dst}: {len(entries)} frames, about {total:.0f} s")
