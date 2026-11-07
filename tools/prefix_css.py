# Usage: python tools/prefix_css.py tools/app.src.css web/css/app.css
# Prefixes every rule with #cqa-d365-root so the widget never styles a host page.
import re, sys
ROOT = "#cqa-d365-root"
src = open(sys.argv[1], encoding="utf-8").read()
src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)

def pref(sel):
    out = []
    for s in sel.split(","):
        s = s.strip()
        if not s: continue
        if s.startswith(":scope"): out.append(ROOT + s[len(":scope"):])
        elif s.startswith(".cqa-host-on"): out.append(ROOT + s)
        else: out.append(ROOT + " " + s)
    return ",\n".join(out)

def walk(text, i=0, depth=0, in_kf=False):
    res = []; buf = ""
    while i < len(text):
        ch = text[i]
        if ch == "{":
            head = buf.strip(); buf = ""
            if head.startswith("@media") or head.startswith("@supports"):
                inner, i = walk(text, i + 1, depth + 1, False)
                res.append(f"{head} {{\n{inner}}}\n")
            elif head.startswith("@keyframes"):
                inner, i = walk(text, i + 1, depth + 1, True)
                res.append(f"{head} {{\n{inner}}}\n")
            else:
                j = text.index("}", i)
                body = text[i + 1:j].strip()
                sel = head if in_kf else pref(head)
                res.append(f"{sel} {{ {body} }}\n")
                i = j + 1
                continue
            continue
        if ch == "}":
            return "".join(res), i + 1
        buf += ch; i += 1
    return "".join(res), i

out, _ = walk(src)
header = "/* Generated: every rule is scoped to #cqa-d365-root so nothing leaks into a host page (Dynamics 365). */\n"
open(sys.argv[2], "w", encoding="utf-8").write(header + out)
print("rules:", out.count("{"), "unscoped:", sum(1 for l in out.splitlines() if l and not l.startswith(("#cqa", "@", "}", " ", "from", "to", "0%", "100%", "20%"))))
