#!/usr/bin/env python3
"""內容包檢查：data/philosophers.json 的結構、引用與用字。不需要瀏覽器。

用法：
  python3 tests/lint_pack.py [路徑，預設 data/philosophers.json]
任何錯誤會讓程式以非 0 結束。
"""
import json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'data' / 'philosophers.json'

errors, warnings = [], []
def err(m): errors.append(m)
def warn(m): warnings.append(m)

try:
    d = json.loads(path.read_text(encoding='utf-8'))
except Exception as e:
    print(f'FAIL 無法讀取或解析 {path}: {e}'); sys.exit(1)

meta = d.get('meta', {})
if not re.fullmatch(r'\d+\.\d+\.\d+', str(meta.get('version', ''))): err('meta.version 必須是 x.y.z')
if not meta.get('notice'): err('meta.notice 不可空白(詮釋聲明)')
if not meta.get('design_rules'): err('meta.design_rules 不可空白')

types = d.get('stuck_types', [])
type_ids = [t.get('id') for t in types]
if len(set(type_ids)) != len(type_ids): err('stuck_types 有重複的 id')
for t in types:
    for k in ('id', 'label', 'hint'):
        if not str(t.get(k, '')).strip(): err(f'stuck_type {t.get("id")}: 缺少 {k}')
    for k in ('label', 'hint'):
        if re.search(r'v\d+\.\d|待加入|TODO', str(t.get(k, ''))): err(f'stuck_type {t.get("id")}.{k} 含有開發備註，使用者會看到')

lenses = d.get('lenses', [])
lens_ids = [l.get('id') for l in lenses]
if len(set(lens_ids)) != len(lens_ids): err('lenses 有重複的 id')

REQ_STR = ['id', 'name', 'name_en', 'years', 'tradition', 'one_liner', 'core_claim', 'thought_experiment', 'micro_action']
REQ_LIST = {'questions': 3, 'blind_spots': 1, 'not_suitable_when': 1, 'reading': 1, 'fits': 1}
for l in lenses:
    i = l.get('id', '?')
    for k in REQ_STR:
        if not str(l.get(k, '')).strip(): err(f'lens {i}: 缺少 {k}')
    for k, n in REQ_LIST.items():
        v = l.get(k)
        if not isinstance(v, list) or len(v) < n or any(not str(x).strip() for x in v):
            err(f'lens {i}: {k} 至少需要 {n} 項非空內容')
    for f in l.get('fits', []):
        if f not in type_ids: err(f'lens {i}: fits 引用了不存在的類型 {f}')
    for p in l.get('pairs_with', []):
        if p not in lens_ids: err(f'lens {i}: pairs_with 引用了不存在的鏡頭 {p}')
        if p == i: err(f'lens {i}: pairs_with 不可指向自己')

for p in d.get('collision_pairs', []):
    a, b = p.get('a'), p.get('b')
    if a not in lens_ids or b not in lens_ids: err(f'collision_pair {a}/{b}: 引用了不存在的鏡頭')
    if a == b: err(f'collision_pair {a}: 兩端相同')
    if not str(p.get('tension', '')).strip(): err(f'collision_pair {a}/{b}: 缺少 tension')

for t in types:
    n = sum(1 for l in lenses if t.get('id') in l.get('fits', []))
    if n < 2: err(f'stuck_type {t.get("id")}: 只有 {n} 面適合的鏡頭，至少需要 2 面才能配對')


# ---- 輕量模式(v0.3)----
SAFE_WORDS = ['低落', '自責', '自我否定', '活著沒有意義']
quick = [l for l in lenses if l.get('quick_ok') is True]
if len(quick) < 5: err(f'quick_ok 的鏡頭至少需要 5 面，目前 {len(quick)}')
for l in lenses:
    i = l.get('id', '?')
    for k in ('angle', 'micro_action_small'):
        if not str(l.get(k, '')).strip(): err(f'lens {i}: 缺少 {k}')
    if not isinstance(l.get('quick_ok'), bool): err(f'lens {i}: quick_ok 必須是 true 或 false')
    if l.get('quick_ok') is True:
        qs = l.get('quick_questions')
        n = len(l.get('questions', []))
        if not isinstance(qs, list) or not qs or any((not isinstance(x, int)) or x < 0 or x >= n for x in qs):
            err(f'lens {i}: quick_ok 的鏡頭需要有效的 quick_questions(題目索引)')
        # 安全不變量：自己寫了「低落/自責時不宜」的鏡頭，不可進輕量模式
        if any(w in str(x) for x in l.get('not_suitable_when', []) for w in SAFE_WORDS):
            err(f'lens {i}: not_suitable_when 提到低落或自責，但 quick_ok 為 true')

entries = d.get('entries', [])
eids = [e.get('id') for e in entries]
if len(set(eids)) != len(eids): err('entries 有重複的 id')
if not any(e.get('primary') for e in entries): err('entries 至少需要一個 primary')
if not any(e.get('type') is None for e in entries): err('entries 需要一個「說不清楚」入口(type 為 null)')
by_id = {l.get('id'): l for l in lenses}
for e in entries:
    k = e.get('id')
    if not str(e.get('label', '')).strip(): err(f'entry {k}: 缺少 label')
    if e.get('type') is not None and e.get('type') not in type_ids: err(f'entry {k}: type 不存在')
    for lid in e.get('lenses', []):
        if lid not in by_id: err(f'entry {k}: 引用了不存在的鏡頭 {lid}')
        elif by_id[lid].get('quick_ok') is not True: err(f'entry {k}: 鏡頭 {lid} 不是 quick_ok，不可放進輕量入口')
    if e.get('type') is not None and not e.get('lenses'): err(f'entry {k}: 有 type 的入口需要至少一面鏡頭')
    if len(str(e.get('label', ''))) > 16 and e.get('primary'): warn(f'entry {k}: primary 的 label 偏長(手機上可能換行)')


# ---- 首頁、入口與聊聊(v0.4)----
for k in ('tagline', 'tagline_sub'):
    if not str(meta.get(k, '')).strip(): err(f'meta.{k} 不可空白(首頁用)')
modes = d.get('modes', [])
if len(modes) < 1: err('modes 不可空白')
mids = [m.get('id') for m in modes]
if len(set(mids)) != len(mids): err('modes 有重複的 id')
for m in modes:
    k = m.get('id')
    for f in ('label', 'desc', 'effort', 'route'):
        if not str(m.get(f, '')).strip(): err(f'mode {k}: 缺少 {f}')
    if not str(m.get('route', '')).startswith('#/'): err(f'mode {k}: route 必須以 #/ 開頭')
    if m.get('lens') not in by_id: err(f'mode {k}: lens 不存在')
    if len(str(m.get('desc', ''))) > 22: warn(f'mode {k}: desc 偏長(手機上會換行)')

chats = d.get('chats', [])
cids = [c.get('id') for c in chats]
if len(set(cids)) != len(cids): err('chats 有重複的 id')
if len(chats) < 8: err(f'chats 至少需要 8 則，目前 {len(chats)}')
for c in chats:
    k = c.get('id')
    for f in ('title', 'story', 'ask', 'source'):
        if not str(c.get(f, '')).strip(): err(f'chat {k}: 缺少 {f}')
    if len(str(c.get('story', ''))) > 140: warn(f'chat {k}: story 偏長(聊聊應該一眼讀完)')
    lid = c.get('lens')
    if lid not in by_id: err(f'chat {k}: lens 不存在')
    elif by_id[lid].get('quick_ok') is not True: err(f'chat {k}: 鏡頭 {lid} 不是 quick_ok，不可用在聊聊')
for l in quick:
    if not any(c.get('lens') == l.get('id') for c in chats): err(f'quick_ok 的鏡頭 {l.get("id")} 沒有任何聊聊故事')

# 用字：中文旁邊不應出現半形標點(台灣用法用全形)
CJK = '\u4e00-\u9fff\u3000-\u303f'
bad = re.compile(rf'[{CJK}][,:;?!()]|[,:;?!(](?=[{CJK}])')
def walk(x, where):
    if isinstance(x, str):
        if bad.search(x): err(f'{where}: 中文旁有半形標點 → {x[:40]}')
    elif isinstance(x, list):
        for i, v in enumerate(x): walk(v, f'{where}[{i}]')
    elif isinstance(x, dict):
        for k, v in x.items(): walk(v, f'{where}.{k}')
walk(d, 'pack')

# 簡體字粗略檢查
SIMP = set('这个们对说让还见现点开关门问题发会时间')
for m in re.finditer(r'.', path.read_text(encoding='utf-8')):
    if m.group() in SIMP: warn(f'可能含有簡體字：{m.group()}'); break

for w in warnings: print('WARN', w)
for e in errors: print('FAIL', e)
print(f'內容包 v{meta.get("version")}：{len(lenses)} 面鏡頭、{len(types)} 種類型、{len(d.get("collision_pairs", []))} 組對撞；錯誤 {len(errors)}，警告 {len(warnings)}')
sys.exit(1 if errors else 0)
