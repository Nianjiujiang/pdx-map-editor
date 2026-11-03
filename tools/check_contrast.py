import re, sys

src = open('web/style.css', encoding='utf-8').read()

def lum(h):
    h = h.strip().lower()
    m = re.fullmatch(r'#([0-9a-f]{3}|[0-9a-f]{6})', h)
    if m:
        s = m.group(1)
        if len(s) == 3:
            s = ''.join(c*2 for c in s)
        r, g, b = (int(s[i:i+2], 16)/255 for i in (0, 2, 4))
        def f(c):
            return c/12.92 if c <= .03928 else ((c+.055)/1.055)**2.4
        return .2126*f(r)+.7152*f(g)+.0722*f(b)
    m = re.fullmatch(r'rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)', h)
    if m:
        r, g, b = (int(m.group(i))/255 for i in (1, 2, 3))
        def f(c):
            return c/12.92 if c <= .03928 else ((c+.055)/1.055)**2.4
        return .2126*f(r)+.7152*f(g)+.0722*f(b)
    return None

# strip comments
src2 = re.sub(r'/\*.*?\*/', '', src, flags=re.S)
rules = re.findall(r'([^{}]+)\{([^{}]*)\}', src2)
line_starts = [0]
for i, ch in enumerate(src):
    if ch == '\n':
        line_starts.append(i+1)

def line_of(pos):
    import bisect
    return bisect.bisect_right(line_starts, pos)

for m in re.finditer(r'([^{}]+)\{([^{}]*)\}', src2):
    sel = ' '.join(m.group(1).split())
    body = m.group(2)
    decls = dict()
    for d in body.split(';'):
        if ':' in d:
            k, v = d.split(':', 1)
            decls[k.strip()] = v.strip()
    bg = decls.get('background') or decls.get('background-color')
    col = decls.get('color')
    if not bg or not col:
        continue
    if 'gradient' in bg or 'url(' in bg:
        continue
    lb = lum(bg)
    lc = lum(col)
    if lb is None or lc is None:
        continue
    if lb < .3 and lc < .3:
        print(f"{line_of(m.start())}: bg={bg} color={col} sel={sel[:120]}")
