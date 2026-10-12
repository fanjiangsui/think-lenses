#!/usr/bin/env python3
"""思考鏡頭 端對端測試(Playwright + Chromium)。

用法：
  python3 tests/e2e.py                      # 自動在本機起一個伺服器測試
  python3 tests/e2e.py --url https://帳號.github.io/think-lenses/   # 測試已部署的網址
  python3 tests/e2e.py --shots tests/out    # 同時輸出截圖
  python3 tests/e2e.py --headed             # 顯示瀏覽器視窗

用兩個互相獨立的瀏覽器環境模擬「手機」與「Mac」，測試備份合併。
任何一項失敗，或出現 console 錯誤，程式會以非 0 結束。
這個測試不會碰你真實瀏覽器裡的資料(每次都是全新的暫時環境)。
"""
import argparse, functools, http.server, json, re, shutil, sys, tempfile, threading, time, urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
results = []


def check(name, cond, extra=''):
    ok = bool(cond)
    results.append((name, ok, extra))
    print(('PASS  ' if ok else 'FAIL  ') + name + (f'    [{extra}]' if (extra and not ok) else ''))


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def start_server():
    handler = functools.partial(Quiet, directory=str(ROOT))
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f'http://127.0.0.1:{srv.server_address[1]}/'


def http_get(url):
    with urllib.request.urlopen(url, timeout=20) as r:
        if r.status != 200:
            raise RuntimeError(f'{url} -> {r.status}')
        return r.read()


def run(base, shots, headed, tmp):
    errors = []

    def hook(pg):
        pg.on('console', lambda m: errors.append(f'console.{m.type}: {m.text}') if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))

    def snap(pg, name, full=False):
        if shots:
            pg.screenshot(path=str(shots / f'{name}.png'), full_page=full)

    def plain(pg):
        box = pg.locator('#encOn')
        if box.is_checked():
            box.uncheck()

    def toast_after(pg, action):
        pg.evaluate("() => { const t = document.querySelector('#toast'); t.classList.remove('show'); t.textContent = ''; }")
        action()
        pg.wait_for_function("() => { const t = document.querySelector('#toast'); return t.classList.contains('show') && t.textContent.length > 0; }")
        return pg.locator('#toast').inner_text()

    def no_hscroll(pg):
        return pg.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth')

    # ---------- 靜態檢查(不需瀏覽器) ----------
    pack = json.loads(http_get(base + 'data/philosophers.json'))
    version = pack['meta']['version']
    n_types, n_lenses = len(pack['stuck_types']), len(pack['lenses'])
    sw = http_get(base + 'sw.js').decode('utf-8')
    block = re.search(r'ASSETS\s*=\s*\[(.*?)\];', sw, re.S)
    assets = re.findall(r"'(\./[^']*)'", block.group(1)) if block else []
    missing = []
    for a in assets:
        try:
            http_get(base + a[2:])
        except Exception:
            missing.append(a)
    check('sw.js 的 ASSETS 全部存在', assets and not missing, f'缺少 {missing}')
    manifest = json.loads(http_get(base + 'manifest.webmanifest'))
    bad_icons = []
    for ic in manifest['icons']:
        try:
            http_get(base + ic['src'])
        except Exception:
            bad_icons.append(ic['src'])
    check('manifest 的圖示全部存在', not bad_icons, str(bad_icons))
    check('manifest 為 standalone 且 scope 為相對路徑', manifest.get('display') == 'standalone' and manifest.get('scope') == './')

    with sync_playwright() as p:
        b = p.chromium.launch(headless=not headed)
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, locale='zh-TW', accept_downloads=True, device_scale_factor=2)
        page = ctx.new_page()
        hook(page)

        # ---------- 首頁與開始思考 ----------
        page.goto(base)
        page.wait_for_selector('.entry')
        home_text = page.locator('#app').inner_text()
        check('首頁顯示 app 名稱、一句話說明與定位', '思考鏡頭' in home_text and pack['meta']['tagline'] in home_text and pack['meta']['tagline_sub'] in home_text)
        check('首頁不再以「你是哪一種」的診斷問題開頭', '現在比較像哪一種' not in home_text)
        check('首頁的五個入口名稱與順序和內容包一致', page.locator('.entry .t').all_inner_texts() == [m['label'] for m in pack['modes']])
        check('首頁的入口連結正確', [a.get_attribute('href') for a in page.locator('a.entry').all()] == [m['route'] for m in pack['modes']])
        check('每個入口都標示要花多少力氣', page.locator('.entry .eff').count() == len(pack['modes']))
        check('首頁有「今日一顆」，且連到完整頁', page.locator('.today').is_visible() and '今日一顆' in page.locator('.today').inner_text() and page.locator('.today a[href="#/dose"]').count() == 1)
        check('首頁零輸入(沒有任何輸入欄)', page.locator('#app textarea, #app input').count() == 0)
        check('首頁沒有橫向捲動(手機寬度)', no_hscroll(page))
        check('全新使用者的首頁沒有任何提示框', page.locator('.notice').count() == 0)
        home_today_q = page.locator('.todayq').inner_text()
        snap(page, '01_home')

        page.click('a.entry[href="#/unlock"]')
        page.wait_for_selector('.row.big')
        check('解鎖人生頁列出所有狀況入口', page.locator('.row.big').count() == len(pack['entries']))
        check('解鎖人生頁零輸入', page.locator('#app textarea, #app input').count() == 0)
        page.click('a.row.big[href="#/q/decision"]')
        page.wait_for_selector('.bigq')
        check('輕量流程的「重選」回到解鎖人生頁', page.locator('.crumb a').first.get_attribute('href') == '#/unlock')

        page.goto(base + '#/deep')
        page.wait_for_selector('.rows .row')
        check('深入思考列出所有卡住類型', page.locator('.rows .row').count() == n_types, f'{page.locator(".rows .row").count()} vs {n_types}')
        page.click('a.row[href="#/new/decision"]')
        page.wait_for_selector('#recBox .venn')
        check('顯示兩個重疊的鏡頭圓', page.locator('.venn .ring').count() == 2)
        check('預設勾選 2 面鏡頭', page.locator('input[name=lens]:checked').count() == 2)
        page.click('button[data-act=start]')
        check('沒寫問題時不會建立紀錄', '#/new/' in page.url)
        page.fill('#problem', '要不要接下新的專案，我擔心影響陪家人的時間')
        for _ in range(6):
            page.click('text=換一組')
        check('換一組後仍勾選 2 面', page.locator('input[name=lens]:checked').count() == 2)
        snap(page, '02_new', True)
        page.click('button[data-act=start]')
        page.wait_for_selector('#panel .lens')
        check('進入思考頁', '#/s/' in page.url, page.url)
        check('問題文字保留', '新的專案' in page.input_value('#problem'))
        check('盲點與不適用區塊可見', page.locator('#panel .caution').is_visible())
        check('思考頁沒有橫向捲動', no_hscroll(page))

        # ---------- 作答與自動儲存 ----------
        page.locator('#panel textarea').first.fill('我最在意的是不要錯過孩子成長')
        tabs = page.locator('.tab')
        check('至少兩個鏡頭分頁', tabs.count() >= 2, str(tabs.count()))
        tabs.nth(1).click()
        page.locator('#panel textarea').first.fill('第二面鏡頭的回答')
        tabs.nth(0).click()
        check('切換分頁後回答仍在', '孩子成長' in page.locator('#panel textarea').first.input_value())
        page.fill('#judgment', '先接，但約定每週兩個晚上不加班')
        check('寫判斷後自動帶出回顧日期', page.input_value('#review_at') != '', page.input_value('#review_at'))
        page.fill('#next_step', '週五前跟主管確認')
        page.locator('.seg input[name=confidence][value="4"]').check(force=True)
        page.wait_for_timeout(700)
        snap(page, '03_session', True)
        s = json.loads(page.evaluate("localStorage.getItem('tl.sessions.v1')"))[0]
        check('儲存了問題', '新的專案' in s['problem'])
        check('儲存了 2 則回答', len(s['answers']) == 2, json.dumps(s['answers'], ensure_ascii=False))
        check('儲存了結論與確定度', s['conclusion']['confidence'] == 4 and '不加班' in s['conclusion']['judgment'])
        check('紀錄了內容包版本', s['pack_version'] == version, f"{s['pack_version']} vs {version}")
        check('深入思考的紀錄標記為 deep', s.get('mode') == 'deep')
        sid = s['id']

        page.reload()
        page.wait_for_selector('#panel .lens')
        check('重新整理後內容仍在', '先接' in page.input_value('#judgment'))

        # ---------- 紀錄、鏡頭庫、關於 ----------
        page.click('nav a[href="#/history"]')
        page.wait_for_selector('h1:has-text("紀錄")')
        page.wait_for_selector('.rows .row')
        check('紀錄列表有 1 則', page.locator('.rows .row').count() == 1)
        snap(page, '04_history')
        page.click('nav a[href="#/library"]')
        page.wait_for_selector('.rows .row[href^="#/lens/"]')
        check('鏡頭庫列出所有鏡頭', page.locator('.rows .row[href^="#/lens/"]').count() == n_lenses)
        check('鏡頭庫沒有橫向捲動', no_hscroll(page))
        for l in pack['lenses']:
            page.goto(base + f'#/lens/{l["id"]}')
            page.wait_for_selector('.lens .caution')
            if not page.locator('.lens .caution li').count():
                check(f'鏡頭 {l["id"]} 顯示盲點', False)
                break
        else:
            check('每面鏡頭都顯示盲點與不適用情況', True)
        if any(l['id'] == 'camus' for l in pack['lenses']):
            page.goto(base + '#/lens/camus')
            page.wait_for_selector('.lens .caution')
            check('卡繆卡提醒低落時尋求專業協助', '專業協助' in page.locator('.caution').inner_text())
        page.goto(base + '#/about')
        page.wait_for_selector('h1')
        check('關於頁含求助資訊', '1925' in page.locator('#app').inner_text())

        # ---------- 備份：匯出 ----------
        page.goto(base + '#/backup')
        page.wait_for_selector('[data-act=download]')
        page.wait_for_selector('#persistState:not(:has-text("檢查中"))', timeout=5000)
        check('備份頁沒有橫向捲動', no_hscroll(page))
        snap(page, '05_backup', True)
        plain(page)
        with page.expect_download() as dl:
            page.click('[data-act=download]')
        path1 = tmp / 'export1.json'
        shutil.copy(dl.value.path(), path1)
        exp = json.loads(path1.read_text(encoding='utf-8'))
        check('備份檔格式正確', exp['app'] == 'think-lenses' and exp['export_version'] == 1 and len(exp['sessions']) == 1)
        check('備份頁顯示上次匯出時間', page.locator('#lastExport').inner_text() != '還沒有')

        # ---------- 模擬第二台裝置 ----------
        ctx2 = b.new_context(viewport={'width': 1280, 'height': 800}, locale='zh-TW', accept_downloads=True)
        p2 = ctx2.new_page()
        hook(p2)

        def import_file(pg, path):
            pg.goto(base + '#/backup')
            pg.wait_for_selector('#importFile', state='attached')
            pg.set_input_files('#importFile', str(path))
            pg.wait_for_selector('.notice[role=status]')
            return pg.locator('.notice[role=status]').inner_text()

        def export_file(pg, name):
            pg.goto(base + '#/backup')
            pg.wait_for_selector('[data-act=download]')
            plain(pg)
            with pg.expect_download() as d:
                pg.click('[data-act=download]')
            out = tmp / name
            shutil.copy(d.value.path(), out)
            return out

        msg = import_file(p2, path1)
        check('第二台匯入：新增 1 則', '新增 1 則' in msg, msg)
        msg = import_file(p2, path1)
        check('重複匯入：沒有變動', '沒有變動 1 則' in msg, msg)

        p2.goto(base + f'#/s/{sid}')
        p2.wait_for_selector('#judgment')
        time.sleep(0.05)
        p2.fill('#judgment', '改成：不接，理由是陪家人時間')
        p2.wait_for_timeout(700)
        path2 = export_file(p2, 'export2.json')
        msg = import_file(page, path2)
        check('較新的備份會更新原裝置', '更新 1 則' in msg, msg)
        msg = import_file(p2, path1)
        check('較舊的備份不會覆蓋較新的內容', '沒有變動 1 則' in msg, msg)
        j = p2.evaluate("JSON.parse(localStorage.getItem('tl.sessions.v1'))[0].conclusion.judgment")
        check('第二台保留較新的文字', '不接' in j, j)

        # 刪除會傳遞
        page.goto(base + f'#/s/{sid}')
        page.wait_for_selector('#judgment')
        page.once('dialog', lambda d: d.accept())
        page.click('[data-act=delete]')
        page.wait_for_selector('text=還沒有紀錄')
        raw = json.loads(page.evaluate("localStorage.getItem('tl.sessions.v1')"))
        check('刪除後只留墓碑，內容已清空', raw[0].get('deleted_at') and 'problem' not in raw[0] and 'answers' not in raw[0], json.dumps(raw[0], ensure_ascii=False))
        path3 = export_file(page, 'export3.json')
        import_file(p2, path3)
        p2.goto(base + '#/history')
        p2.wait_for_selector('text=還沒有紀錄')
        check('刪除已傳遞到第二台', True)

        # ---------- 錯誤與惡意輸入 ----------
        (tmp / 'bad.json').write_text('{"hello":1}', encoding='utf-8')
        check('非備份檔被拒絕', '匯入失敗' in import_file(p2, tmp / 'bad.json'))
        (tmp / 'garbage.json').write_text('not json at all', encoding='utf-8')
        check('壞掉的 JSON 被拒絕', '匯入失敗' in import_file(p2, tmp / 'garbage.json'))
        (tmp / 'future.json').write_text(json.dumps({'app': 'think-lenses', 'export_version': 99, 'sessions': []}), encoding='utf-8')
        check('較新版本的備份被拒絕', '更新 app' in import_file(p2, tmp / 'future.json'))
        evil = {'app': 'think-lenses', 'export_version': 1, 'sessions': [{
            'id': 'x1', 'created_at': '2026-10-12T00:00:00Z', 'updated_at': '2026-10-12T00:00:00Z',
            'problem': '<img src=x onerror=window.__xss=1>', 'stuck_type': 'decision', 'lenses_used': ['kant'],
            'answers': [{'lens': 'kant', 'kind': 'question', 'question_index': 0, 'my_answer': '<script>window.__xss=1</script>'}],
            'conclusion': {'judgment': '<script>window.__xss=1</script>'}}]}
        (tmp / 'evil.json').write_text(json.dumps(evil), encoding='utf-8')
        import_file(p2, tmp / 'evil.json')
        p2.goto(base + '#/history')
        p2.wait_for_selector('.rows .row')
        p2.goto(base + '#/s/x1')
        p2.wait_for_selector('#panel .lens')
        check('匯入的惡意 HTML 不會執行', p2.evaluate('window.__xss === undefined'))
        check('惡意文字以純文字顯示', '<img' in p2.input_value('#problem'))

        # ---------- 到期回顧 ----------
        due = {'app': 'think-lenses', 'export_version': 1, 'sessions': [{
            'id': 'd1', 'created_at': '2026-01-01T00:00:00Z', 'updated_at': '2026-01-01T00:00:00Z',
            'problem': '舊的判斷', 'stuck_type': 'meaning', 'lenses_used': ['camus', 'zhuangzi'], 'answers': [],
            'conclusion': {'judgment': '先不動', 'next_step': '', 'confidence': 3}, 'review_at': '2026-04-01', 'review_result': None}]}
        (tmp / 'due.json').write_text(json.dumps(due), encoding='utf-8')
        import_file(p2, tmp / 'due.json')
        p2.goto(base + '#/')
        p2.wait_for_selector('.entry')
        check('首頁顯示深入思考到期回顧的提示', '到了回顧時間' in p2.locator('.notice').inner_text())
        p2.goto(base + '#/deep')
        p2.wait_for_selector('.notice h3')
        check('深入思考頁列出到期回顧', '到了回顧時間' in p2.locator('.notice h3').inner_text())
        check('導覽列的「紀錄」有提示點', p2.locator('nav .pip').count() == 1)
        p2.goto(base + '#/s/d1')
        p2.wait_for_selector('#panel .lens')
        p2.locator('.seg input[name=verdict][value="partly"]').check(force=True)
        p2.fill('#review_note', '條件變了一半')
        p2.wait_for_timeout(600)
        p2.goto(base + '#/')
        p2.wait_for_selector('.entry')
        check('填寫回顧後，到期提示消失', p2.locator('.notice').count() == 0)

        # ---------- 輕量模式 ----------
        quick_ok = {l['id'] for l in pack['lenses'] if l.get('quick_ok')}
        allowed_q = {l['id']: {l['questions'][i] for i in l.get('quick_questions', range(len(l['questions'])))} for l in pack['lenses']}
        entries = pack['entries']

        def walk(entry_id):
            """一路按「換個角度」走到小行動畫面，回傳看過的 (鏡頭, 問題)。"""
            page.goto(base + f'#/q/{entry_id}')
            page.wait_for_selector('.bigq')
            seen = []
            for _ in range(8):
                if page.locator('.angle').count() == 0:
                    break
                seen.append((page.locator('.angle').get_attribute('data-lens'), page.locator('.bigq').inner_text()))
                if page.locator('[data-act=q-switch]').count() == 0:
                    page.click('[data-act=q-act]')
                else:
                    page.click('[data-act=q-switch]')
            return seen

        bad_lens, bad_q, over_pool = [], [], []
        for e in entries:
            for _ in range(3):  # 起點是隨機的，多走幾次
                for lid, q in walk(e['id']):
                    if lid not in quick_ok: bad_lens.append((e['id'], lid))
                    if q not in allowed_q[lid]: bad_q.append((e['id'], lid, q))
                    if e['lenses'] and lid not in e['lenses']: over_pool.append((e['id'], lid))
        check('輕量模式只會出現 quick_ok 的鏡頭(適合低落時)', not bad_lens, str(bad_lens[:3]))
        check('輕量模式只會出現 quick_questions 內的問題', not bad_q, str(bad_q[:2]))
        check('入口只會用到它指定的鏡頭', not over_pool, str(over_pool[:3]))

        # 單一流程：外觀與步數
        page.goto(base + '#/q/anxiety')
        page.wait_for_selector('.bigq')
        entry_note = next(e.get('note', '') for e in entries if e['id'] == 'anxiety')
        check('第一張卡顯示入口的溫和提醒', not entry_note or entry_note in page.locator('#app').inner_text())
        check('問題卡只有一個主要按鈕', page.locator('.btn.primary').count() == 1)
        check('問題卡沒有必填輸入(筆記預設收合)', page.locator('#app textarea:visible').count() == 0)
        check('問題卡沒有橫向捲動', no_hscroll(page))
        check('問題卡上有「撐不住了？」', page.locator('a[href="#/help"]').count() >= 1)
        page.click('summary:has-text("這個角度的限制")')
        check('角度的限制可展開，且含不適用情況', '不適用' in page.locator('details.fold[open]').inner_text())
        snap(page, '07_quick_card')

        page.goto(base + '#/q/unsure')
        page.wait_for_selector('.bigq')
        cards, shown = 1, []
        for _ in range(10):
            shown.append(page.locator('.angle').get_attribute('data-lens'))
            if page.locator('[data-act=q-next]').count() == 0:
                break
            page.click('[data-act=q-next]')
            if page.locator('.angle').count() == 0:
                break
            cards += 1
        check('輕量流程最多 5 個問題，最後一張只剩「給我一個行動」', cards <= 5 and (page.locator('[data-act=q-act]').count() >= 1 or page.locator('.angle').count() == 0))

        # 寫一則筆記並接受小行動
        page.goto(base + '#/q/anxiety')
        page.wait_for_selector('.bigq')
        page.click('summary:has-text("想寫下來")')
        page.fill('textarea[data-f=qnote]', '今天又睡不著')
        page.wait_for_timeout(600)
        raw = json.loads(page.evaluate("localStorage.getItem('tl.sessions.v1')"))
        qs = [x for x in raw if x.get('mode') == 'quick']
        check('輕量筆記即時存下', len(qs) == 1 and any(a['my_answer'] == '今天又睡不著' for a in qs[0]['answers']))
        page.click('[data-act=q-act]')
        page.wait_for_selector('text=今天只做這一件事')
        check('行動畫面只有一個主要按鈕', page.locator('.btn.primary').count() == 1)
        before = page.locator('.bigq').inner_text()
        if page.locator('[data-act=a-small]').count():
            page.click('[data-act=a-small]')
            after = page.locator('.bigq').inner_text()
            check('「換小一點」會換成更小的行動', after != before and any(after == l.get('micro_action_small') for l in pack['lenses']), after)
        snap(page, '08_quick_action')
        page.click('[data-act=a-accept]')
        page.wait_for_selector('text=已記下')
        raw = json.loads(page.evaluate("localStorage.getItem('tl.sessions.v1')"))
        qs = [x for x in raw if x.get('mode') == 'quick']
        qs0 = qs[0]
        check('接受後儲存小行動(待回訪)與入口', qs0['action']['status'] == 'pending' and qs0['action']['text'] and qs0['entry'] == 'anxiety')
        check('記下了每張卡的回應', len(qs0['reactions']) >= 1 and all(r['reaction'] in ('next', 'switch', 'act') for r in qs0['reactions']))
        check('完成頁沒有橫向捲動', no_hscroll(page))
        qid = qs0['id']

        page.goto(base + '#/')
        page.wait_for_selector('.entry')
        check('小行動當天不會被回訪', page.locator('.notice').count() == 0)

        # 隔天打開：回訪一次
        page.evaluate("""() => {
          const k = 'tl.sessions.v1'; const a = JSON.parse(localStorage.getItem(k));
          const s = a.find(x => x.mode === 'quick' && x.action);
          const d = new Date(); d.setDate(d.getDate() - 1); s.action.at = d.toISOString();
          localStorage.setItem(k, JSON.stringify(a));
        }""")
        page.goto(base + '#/')
        page.reload()
        page.wait_for_selector('.notice h3')
        check('隔天打開會回訪小行動', '做了嗎' in page.locator('.notice h3').inner_text())
        check('回訪提供 3 個一鍵回應', page.locator('[data-act=fu]').count() == 3)
        check('回訪時導覽列有提示點', page.locator('nav .pip').count() == 1)
        snap(page, '09_followup')
        page.click('[data-act=fu][data-s=done]')
        page.wait_for_selector('.entry')
        raw = json.loads(page.evaluate("localStorage.getItem('tl.sessions.v1')"))
        check('回訪後狀態更新為「做了」並消除提示', [x for x in raw if x.get('id') == qid][0]['action']['status'] == 'done' and page.locator('.notice').count() == 0)

        # 輕量紀錄可以事後補充、改狀態
        page.goto(base + f'#/s/{qid}')
        page.wait_for_selector('#problem')
        check('輕量紀錄頁顯示小行動', '小行動' in page.locator('h2').first.inner_text())
        page.locator('input[name=actstatus][value=not_fit]').check(force=True)
        page.wait_for_timeout(600)
        raw = json.loads(page.evaluate("localStorage.getItem('tl.sessions.v1')"))
        check('可在紀錄頁修改小行動狀態', [x for x in raw if x.get('id') == qid][0]['action']['status'] == 'not_fit')
        page.goto(base + '#/history')
        page.wait_for_selector('h1:has-text("紀錄")')
        page.wait_for_selector('.rows .row')
        check('紀錄列表顯示輕量紀錄與狀態', '不適合' in page.locator('.rows .row').first.inner_text())

        # 輕量紀錄可在兩台裝置間合併
        path4 = export_file(page, 'export4.json')
        import_file(p2, path4)
        got = p2.evaluate("(id) => { const s = JSON.parse(localStorage.getItem('tl.sessions.v1')).find(x => x.id === id); return s && s.action && s.action.status; }", qid)
        check('輕量紀錄與小行動狀態可匯入另一台', got == 'not_fit', str(got))

        page.goto(base + '#/help')
        page.wait_for_selector('h1')
        check('求助頁含安心專線', '1925' in page.locator('#app').inner_text())

        # ---------- 腦內風暴 ----------
        quick_ok2 = {l['id'] for l in pack['lenses'] if l.get('quick_ok')}
        allowed2 = {l['id']: {l['questions'][i] for i in l.get('quick_questions', range(len(l['questions'])))} for l in pack['lenses']}

        def sessions_of(pg, mode):
            raw = pg.evaluate("localStorage.getItem('tl.sessions.v1')")
            return [x for x in json.loads(raw or '[]') if x.get('mode') == mode and not x.get('deleted_at')]

        page.goto(base + '#/storm')
        page.wait_for_selector('#thought')
        storm_before = len(sessions_of(page, 'storm'))
        check('腦內風暴：還沒翻之前沒有便條紙', page.locator('#stormNote').count() == 0)
        page.click('[data-act=storm-flip]')
        page.wait_for_selector('.stormcard')
        lens_ids = [c.get_attribute('data-lens') for c in page.locator('.stormcard').all()]
        check('腦內風暴：沒有念頭也能翻出 4 個角度', len(lens_ids) == 4)
        check('腦內風暴：4 個角度各不相同', len(set(lens_ids)) == 4)
        check('腦內風暴：只用適合低落時的鏡頭', set(lens_ids) <= quick_ok2, str(lens_ids))
        pairs2 = {frozenset((p['a'], p['b'])) for p in pack['collision_pairs'] if p['a'] in quick_ok2 and p['b'] in quick_ok2}
        check('腦內風暴：其中包含一組立場對撞的鏡頭', (not pairs2) or any(frozenset((a, b)) in pairs2 for a in lens_ids for b in lens_ids if a < b))
        bad = [(c.get_attribute('data-lens'), c.locator('.stormq').inner_text()) for c in page.locator('.stormcard').all() if c.locator('.stormq').inner_text() not in allowed2[c.get_attribute('data-lens')]]
        check('腦內風暴：只出現溫和的問題', not bad, str(bad[:2]))
        check('腦內風暴：沒有輸入時不建立紀錄', len(sessions_of(page, 'storm')) == storm_before)
        check('腦內風暴沒有橫向捲動', no_hscroll(page))
        snap(page, '11_storm')
        page.fill('#thought', '要不要換工作')
        page.fill('#stormNote', '便條：先列出三個擔心')
        page.wait_for_timeout(700)
        st = sessions_of(page, 'storm')
        check('腦內風暴：念頭、便條與 4 張卡即時存下', len(st) == storm_before + 1 and st[-1]['problem'] == '要不要換工作' and '三個擔心' in st[-1]['note'] and len(st[-1]['cards']) == 4)
        sid_storm = st[-1]['id']
        first_lens = page.locator('.stormcard').first.get_attribute('data-lens')
        page.locator('[data-act=storm-swap]').first.click()
        page.wait_for_function("(l) => document.querySelector('.stormcard').dataset.lens !== l", arg=first_lens)
        lens_after = [c.get_attribute('data-lens') for c in page.locator('.stormcard').all()]
        check('「換一個」換成不重複的鏡頭並存下', len(set(lens_after)) == 4 and [c['lens'] for c in sessions_of(page, 'storm')[-1]['cards']] == lens_after)
        page.click('text=再翻一組')
        page.wait_for_selector('.stormcard')
        check('「再翻一組」保留念頭與便條', page.input_value('#thought') == '要不要換工作' and '三個擔心' in page.input_value('#stormNote'))
        page.goto(base + '#/history')
        page.wait_for_selector('h1:has-text("紀錄")')
        page.wait_for_selector('.rows .row')
        check('紀錄列表標示「腦內風暴」', '腦內風暴' in page.locator('.rows .row').first.inner_text())
        page.locator('.rows .row').first.click()
        page.wait_for_selector('#stormNote')
        check('從紀錄回到腦內風暴頁，便條仍在', '#/storm/' in page.url and '三個擔心' in page.input_value('#stormNote'))
        path5 = export_file(page, 'export5.json')
        import_file(p2, path5)
        got = p2.evaluate("(id) => { const s = JSON.parse(localStorage.getItem('tl.sessions.v1')).find(x => x.id === id); return s && [s.mode, s.note, s.cards.length]; }", sid_storm)
        check('腦內風暴紀錄可匯入另一台', got and got[0] == 'storm' and '三個擔心' in got[1] and got[2] == 4, str(got))
        page.goto(base + f'#/storm/{sid_storm}')
        page.wait_for_selector('#stormNote')
        page.once('dialog', lambda d: d.accept())
        msg = toast_after(page, lambda: page.click('[data-act=delete]'))
        check('腦內風暴紀錄可刪除並復原', '已刪除 1 則' in msg and page.locator('#toast .toast-btn').count() == 1, msg)
        page.click('#toast .toast-btn')
        page.wait_for_function("document.querySelectorAll('.rows .row').length >= 1")
        check('復原後腦內風暴紀錄回來', len(sessions_of(page, 'storm')) == storm_before + 1)

        # ---------- 轉換心境，聊聊而已：不寫入任何紀錄 ----------
        snapshot = "JSON.stringify(Object.entries(localStorage).sort())"
        before = page.evaluate(snapshot)
        page.goto(base + '#/chat')
        page.wait_for_selector('.story')
        check('聊聊：沒有任何輸入欄', page.locator('#app textarea, #app input').count() == 0)
        check('聊聊：沒有橫向捲動', no_hscroll(page))
        snap(page, '12_chat')
        titles, chat_lenses = [], []
        for _ in range(30):
            if page.locator('.story').count() == 0:
                break
            titles.append(page.locator('.angle').inner_text())
            chat_lenses.append(page.locator('.angle').get_attribute('data-lens'))
            page.click('[data-act=chat-next]')
        n_stories = len([c for c in pack['chats'] if c['lens'] in quick_ok2])
        check('聊聊：每則故事只出現一次', len(titles) == n_stories and len(set(titles)) == len(titles), f'{len(titles)} vs {n_stories}')
        check('聊聊：故事只來自適合低落時的鏡頭', set(chat_lenses) <= quick_ok2)
        check('聊聊：聽完會說明沒有留下任何紀錄', '沒有留下任何紀錄' in page.locator('#app').inner_text())
        page.click('[data-act=chat-restart]')
        page.wait_for_selector('.story')
        page.click('[data-act=chat-stop]')
        check('聊聊：可以隨時說「夠了」', '夠了' in page.locator('h1').inner_text())
        check('聊聊：整個過程沒有寫入任何儲存空間', page.evaluate(snapshot) == before)

        # ---------- 補充觀點：每天一顆 ----------
        page.goto(base + '#/dose')
        page.wait_for_selector('.dose')
        check('補充觀點：沒有任何輸入欄', page.locator('#app textarea, #app input').count() == 0)
        check('補充觀點的今日一顆與首頁一致', page.locator('.dose .askq').inner_text() == home_today_q, f'{page.locator(".dose .askq").inner_text()} vs {home_today_q}')
        check('補充觀點：附有這個角度的限制', page.locator('.dose summary').inner_text() == '這個角度的限制')
        total = page.locator('.shelf .r').count()
        check('補充觀點：顯示「你的角度」累積', total == len(quick_ok2) and page.locator('.shelf .r.seen').count() == 1)
        prev_q = page.locator('.dose .askq').inner_text()
        page.click('[data-act=dose-more]')
        check('「再來一顆」會換一顆', page.locator('.dose .askq').inner_text() != prev_q)
        for _ in range(80):
            if page.locator('.shelf .r.seen').count() == total:
                break
            page.click('[data-act=dose-more]')
        check('多讀幾顆後，角度累積到全部', page.locator('.shelf .r.seen').count() == total)
        meta_seen = json.loads(page.evaluate("localStorage.getItem('tl.meta.v1')")).get('seen', {})
        check('讀過的角度有存在本機', len(meta_seen) == total)
        check('補充觀點沒有橫向捲動', no_hscroll(page))
        snap(page, '13_dose')

        clk = b.new_context(viewport={'width': 390, 'height': 844}, locale='zh-TW')
        cp = clk.new_page()
        hook(cp)

        def today_q(when):
            cp.clock.set_fixed_time(when)
            cp.goto(base)
            cp.wait_for_selector('.today')
            return cp.locator('.todayq').inner_text()

        qa = today_q('2026-03-01T12:00:00')
        qb = today_q('2026-03-02T12:00:00')
        qa2 = today_q('2026-03-01T22:30:00')
        check('今日一顆：每天不同，同一天固定', qa != qb and qa == qa2, f'{qa} | {qb} | {qa2}')
        pool_q = {l['questions'][i] for l in pack['lenses'] if l.get('quick_ok') for i in l.get('quick_questions', range(len(l['questions'])))}
        month = [today_q(f'2026-04-{d:02d}T12:00:00') for d in range(1, 26)]
        check('今日一顆：連續 25 天都只來自適合低落時的問題，且輪完整個池', set(month) == pool_q, f'{len(set(month))} vs {len(pool_q)}')
        page.goto(base + '#/history')
        page.wait_for_selector('h1:has-text("紀錄")')
        page.wait_for_selector('.rows .row')
        hist = page.locator('.rows').inner_text()
        check('紀錄列表同時標示各種模式', '腦內風暴' in hist and '解鎖人生' in hist)

        # ---------- 資料保護：刪除、加密備份、App 鎖、背景遮蔽 ----------
        ctx3 = b.new_context(viewport={'width': 390, 'height': 844}, locale='zh-TW', accept_downloads=True)
        s3 = ctx3.new_page()
        hook(s3)
        dls3 = []
        s3.on('download', lambda d: dls3.append(d))

        def mk(i, problem):
            return {'id': f'seed-{i}', 'created_at': '2026-01-05T08:00:00.000Z', 'updated_at': f'2026-01-05T08:0{i}:00.000Z',  # 刻意用過去的時間，才能驗證「復原」確實比墓碑新
                    'mode': 'deep', 'problem': problem, 'stuck_type': 'decision', 'lenses_used': ['kant'], 'pack_version': version,
                    'answers': [{'lens': 'kant', 'kind': 'question', 'question_index': 0, 'my_answer': 'ANSWER-' + problem}],
                    'conclusion': {'judgment': 'J-' + problem, 'next_step': '', 'confidence': 3}, 'review_at': None, 'review_result': None}

        s3.goto(base)
        s3.wait_for_selector('.entry')
        s3.evaluate("(v) => localStorage.setItem('tl.sessions.v1', JSON.stringify(v))", [mk(1, 'SECRET-甲'), mk(2, 'SECRET-乙'), mk(3, 'SECRET-丙')])
        s3.goto(base + '#/history')
        s3.reload()
        s3.wait_for_selector('.rows .row')

        def raw3():
            return s3.evaluate("localStorage.getItem('tl.sessions.v1')")

        # --- 刪除：整理模式、批次、復原 ---
        check('(種子)紀錄列表有 3 則', s3.locator('.rows .row').count() == 3)
        s3.click('[data-act=manage-on]')
        s3.wait_for_selector('.pickrow')
        check('整理模式：每列有勾選框', s3.locator('.pickrow input[name=pick]').count() == 3)
        check('整理模式：未選時不能刪除', s3.locator('#delPicked').is_disabled())
        s3.locator('.pickrow input').nth(0).check()
        s3.locator('.pickrow input').nth(1).check()
        check('整理模式：顯示已選 2 則並可刪除', '已選 2 則' in s3.locator('#pickN').inner_text() and s3.locator('#delPicked').is_enabled())
        s3.once('dialog', lambda d: d.accept())
        msg = toast_after(s3, lambda: s3.click('#delPicked'))
        check('刪除後出現「復原」按鈕', '已刪除 2 則' in msg and s3.locator('#toast .toast-btn').count() == 1, msg)
        data = json.loads(raw3())
        tombs = [x for x in data if x.get('deleted_at')]
        check('批次刪除只留墓碑，內容清空', len(tombs) == 2 and all(set(x.keys()) == {'id', 'created_at', 'updated_at', 'deleted_at'} for x in tombs))
        check('儲存空間不再含已刪除的內容', 'SECRET-丙' not in raw3() and 'SECRET-乙' not in raw3() and 'SECRET-甲' in raw3())
        check('刪除後列表只剩 1 則', s3.locator('.rows .row').count() == 1)
        tomb_at = max(x['deleted_at'] for x in tombs)
        s3.click('#toast .toast-btn')
        s3.wait_for_function("document.querySelectorAll('.rows .row').length === 3")
        back = {x['id']: x for x in json.loads(raw3())}
        check('復原後內容回來', all(back[i].get('problem') and back[i].get('answers') for i in ('seed-1', 'seed-2', 'seed-3')))
        check('復原的 updated_at 比墓碑新(才能蓋過已同步的刪除)', back['seed-3']['updated_at'] > tomb_at)
        s3.click('[data-act=pick-all]')
        check('全選後顯示已選 3 則', '已選 3 則' in s3.locator('#pickN').inner_text())
        s3.once('dialog', lambda d: d.accept())
        s3.click('#delPicked')
        s3.wait_for_selector('text=還沒有紀錄')
        check('全部刪除後顯示空狀態', 'SECRET' not in raw3())
        s3.click('#toast .toast-btn')
        s3.wait_for_function("document.querySelectorAll('.rows .row').length === 3")
        check('全部刪除後可一鍵復原', 'SECRET-甲' in raw3() and 'SECRET-乙' in raw3() and 'SECRET-丙' in raw3())
        s3.goto(base + '#/s/seed-1')
        s3.wait_for_selector('#judgment')
        s3.once('dialog', lambda d: d.accept())
        msg = toast_after(s3, lambda: s3.click('[data-act=delete]'))
        check('紀錄頁刪除同樣可復原', '已刪除 1 則' in msg and s3.locator('#toast .toast-btn').count() == 1, msg)
        s3.click('#toast .toast-btn')
        s3.wait_for_function("document.querySelectorAll('.rows .row').length === 3")
        check('紀錄頁刪除後復原成功', 'SECRET-甲' in raw3())

        # --- 加密備份 ---
        s3.goto(base + '#/backup')
        s3.wait_for_selector('#encOn')
        check('加密備份預設開啟', s3.locator('#encOn').is_checked() and s3.locator('#encBox').is_visible())
        n0 = len(dls3)
        msg = toast_after(s3, lambda: s3.click('[data-act=download]'))
        check('沒有密語時不匯出並提示長度', '至少 8' in msg and len(dls3) == n0, msg)
        s3.fill('#encPass', 'correct horse battery')
        s3.fill('#encPass2', 'correct horse batterx')
        msg = toast_after(s3, lambda: s3.click('[data-act=download]'))
        check('兩次密語不一致時不匯出', '不一樣' in msg and len(dls3) == n0, msg)
        s3.fill('#encPass2', 'correct horse battery')
        with s3.expect_download() as dle:
            s3.click('[data-act=download]')
        enc_path = tmp / 'enc.json'
        shutil.copy(dle.value.path(), enc_path)
        enc_txt = enc_path.read_text(encoding='utf-8')
        env = json.loads(enc_txt)
        check('加密備份檔格式(PBKDF2 + AES-GCM)', env.get('encrypted') is True and env['kdf']['name'] == 'PBKDF2' and env['kdf']['iterations'] >= 600000 and env['cipher']['name'] == 'AES-GCM')
        check('加密備份檔不含任何明文', 'SECRET' not in enc_txt and 'sessions' not in enc_txt and 'problem' not in enc_txt and 'ANSWER' not in enc_txt)
        check('加密備份檔名標示 encrypted', '-encrypted' in dle.value.suggested_filename)

        ctx4 = b.new_context(viewport={'width': 390, 'height': 844}, locale='zh-TW')
        p4 = ctx4.new_page()
        hook(p4)

        def import_enc(path):
            p4.goto(base + '#/backup')
            p4.wait_for_selector('#importFile', state='attached')
            p4.set_input_files('#importFile', str(path))
            p4.wait_for_selector('#impPass')

        import_enc(enc_path)
        check('匯入加密檔會要求密語', '加密的備份檔' in p4.locator('.notice').inner_text())
        p4.fill('#impPass', 'wrong password')
        msg = toast_after(p4, lambda: p4.click('[data-act=import-decrypt]'))
        check('密語錯誤不會匯入', '密語不正確' in msg and not p4.evaluate("localStorage.getItem('tl.sessions.v1')") and p4.locator('#impPass').count() == 1, msg)
        p4.fill('#impPass', 'correct horse battery')
        p4.click('[data-act=import-decrypt]')
        p4.wait_for_selector('.notice[role=status]')
        check('密語正確時匯入成功', '新增 3 則' in p4.locator('.notice[role=status]').inner_text(), p4.locator('.notice[role=status]').inner_text())
        check('匯入後內容完整', 'SECRET-甲' in p4.evaluate("localStorage.getItem('tl.sessions.v1')"))

        tampered = dict(env)
        c = tampered['ciphertext']
        tampered['ciphertext'] = ('A' if c[0] != 'A' else 'B') + c[1:]
        (tmp / 'tampered.json').write_text(json.dumps(tampered), encoding='utf-8')
        import_enc(tmp / 'tampered.json')
        p4.fill('#impPass', 'correct horse battery')
        msg = toast_after(p4, lambda: p4.click('[data-act=import-decrypt]'))
        check('被竄改的加密檔會被拒絕', '損毀' in msg, msg)
        (tmp / 'badfmt.json').write_text(json.dumps({'app': 'think-lenses', 'export_version': 1, 'encrypted': True}), encoding='utf-8')
        import_enc(tmp / 'badfmt.json')
        p4.fill('#impPass', 'x')
        msg = toast_after(p4, lambda: p4.click('[data-act=import-decrypt]'))
        check('格式不完整的加密檔會被拒絕', '格式不正確' in msg, msg)
        huge = json.loads(enc_txt)
        huge['kdf']['iterations'] = 10 ** 9
        (tmp / 'huge.json').write_text(json.dumps(huge), encoding='utf-8')
        import_enc(tmp / 'huge.json')
        p4.fill('#impPass', 'correct horse battery')
        msg = toast_after(p4, lambda: p4.click('[data-act=import-decrypt]'))
        check('過大的 KDF 次數被拒絕(避免被惡意檔卡死)', '格式不正確' in msg, msg)
        p4.click('[data-act=import-cancel]')
        check('可取消解密', p4.locator('#impPass').count() == 0)

        s3.goto(base + '#/backup')
        s3.wait_for_selector('#encOn')
        s3.locator('#encOn').uncheck()
        s3.reload()
        s3.wait_for_selector('#encOn')
        check('取消加密的選擇會被記住', not s3.locator('#encOn').is_checked() and s3.locator('#encBox').is_hidden())

        # --- App 鎖與背景遮蔽 ---
        def try_pin(pin):
            s3.evaluate("() => { const m = document.querySelector('#lockMsg'); if (m) m.textContent = ''; }")
            s3.fill('#pin', pin)
            s3.click('[data-act=unlock]')
            s3.wait_for_function("() => { const m = document.querySelector('#lockMsg'); return !document.querySelector('#pin') || (m && m.textContent.length > 0); }")
            return s3.locator('#lockMsg').inner_text() if s3.locator('#lockMsg').count() else ''

        def set_vis(state):
            s3.evaluate("(s) => { Object.defineProperty(document, 'visibilityState', { value: s, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); }", state)

        s3.goto(base + '#/backup')
        s3.wait_for_selector('#lockNew')
        check('預設沒有開啟 App 鎖', s3.evaluate("localStorage.getItem('tl.lock.v1')") is None)
        msg = toast_after(s3, lambda: (s3.fill('#lockNew', '12'), s3.fill('#lockNew2', '12'), s3.click('[data-act=lock-on]')))
        check('太短的 PIN 被拒絕', '至少 4' in msg, msg)
        msg = toast_after(s3, lambda: (s3.fill('#lockNew', '2468'), s3.fill('#lockNew2', '2469'), s3.click('[data-act=lock-on]')))
        check('兩次 PIN 不一致被拒絕', '不一樣' in msg, msg)
        s3.fill('#lockNew', '2468')
        s3.fill('#lockNew2', '2468')
        s3.select_option('#lockTimeout', '0')
        s3.click('[data-act=lock-on]')
        s3.wait_for_selector('#lockCur')
        lock_raw = s3.evaluate("localStorage.getItem('tl.lock.v1')")
        check('PIN 只存雜湊，不存明文', lock_raw and '2468' not in lock_raw and set(json.loads(lock_raw)) == {'salt', 'iterations', 'hash', 'timeout', 'fails', 'until'}, str(lock_raw)[:80])
        check('「這是遮罩，不是加密」有明確說明', '不是加密' in s3.locator('#app').inner_text())

        s3.reload()
        s3.wait_for_selector('#pin')
        check('重新開啟後出現鎖定畫面', True)
        check('鎖定畫面不含任何紀錄內容，也沒有導覽', 'SECRET' not in s3.locator('body').inner_text() and s3.locator('#nav a').count() == 0)
        check('鎖定畫面沒有橫向捲動', no_hscroll(s3))
        snap(s3, '10_lock')
        check('錯誤 PIN 被拒絕', '不正確' in try_pin('0000'))
        for _ in range(3):
            try_pin('1111')
        msg = try_pin('2222')
        check('連續輸錯 5 次後暫時鎖住', '太多次' in msg, msg)
        msg = try_pin('2468')
        check('鎖住期間，即使 PIN 正確也不放行', '太多次' in msg and s3.locator('#pin').count() == 1, msg)
        s3.evaluate("() => { const k = 'tl.lock.v1'; const c = JSON.parse(localStorage.getItem(k)); c.until = 0; c.fails = 0; localStorage.setItem(k, JSON.stringify(c)); }")
        s3.reload()
        s3.wait_for_selector('#pin')
        s3.fill('#pin', '2468')
        s3.press('#pin', 'Enter')
        s3.wait_for_selector('#lockCur')
        check('PIN 正確(按 Enter)即解鎖', s3.locator('#pin').count() == 0 and s3.locator('#nav a').count() == 4)

        s3.goto(base + '#/')
        s3.wait_for_selector('.entry')
        s3.click('[data-act=lock-now]')
        s3.wait_for_selector('#pin')
        check('首頁的「鎖定」可立即鎖上', True)
        try_pin('2468')
        s3.wait_for_selector('.entry')

        set_vis('hidden')
        check('切到背景時遮蔽畫面', s3.evaluate("document.body.classList.contains('cover')"))
        set_vis('visible')
        s3.wait_for_selector('#pin')
        check('自動鎖定「立即」：回到前景會鎖上，且遮蔽已移除', not s3.evaluate("document.body.classList.contains('cover')"))
        try_pin('2468')
        s3.goto(base + '#/backup')
        s3.wait_for_selector('#lockTimeout')
        s3.select_option('#lockTimeout', 'never')
        s3.wait_for_function("JSON.parse(localStorage.getItem('tl.lock.v1')).timeout === 'never'")
        set_vis('hidden')
        set_vis('visible')
        s3.wait_for_timeout(300)
        check('自動鎖定「只在重新開啟時」：回到前景不鎖', s3.locator('#pin').count() == 0)
        s3.locator('#coverOn').uncheck()
        set_vis('hidden')
        check('可關閉背景遮蔽', not s3.evaluate("document.body.classList.contains('cover')"))
        set_vis('visible')
        s3.locator('#coverOn').check()

        msg = toast_after(s3, lambda: (s3.fill('#lockCur', '9999'), s3.click('[data-act=lock-off]')))
        check('關閉 App 鎖需要正確的 PIN', '不正確' in msg and s3.evaluate("localStorage.getItem('tl.lock.v1')") is not None, msg)
        s3.fill('#lockCur', '2468')
        s3.click('[data-act=lock-off]')
        s3.wait_for_selector('#lockNew')
        s3.reload()
        s3.wait_for_selector('#lockNew')
        check('關閉後重新開啟不再鎖定', s3.evaluate("localStorage.getItem('tl.lock.v1')") is None and s3.locator('#pin').count() == 0)

        # 忘記 PIN：只能清除資料
        s3.goto(base + '#/backup')
        s3.wait_for_selector('#lockNew')
        s3.fill('#lockNew', '1357')
        s3.fill('#lockNew2', '1357')
        s3.click('[data-act=lock-on]')
        s3.wait_for_selector('#lockCur')
        s3.reload()
        s3.wait_for_selector('#pin')
        s3.once('dialog', lambda d: d.accept('清除'))
        s3.click('[data-act=forgot-pin]')
        s3.wait_for_selector('#lockNew')
        check('忘記 PIN：清除所有紀錄後解除鎖定', s3.evaluate("localStorage.getItem('tl.lock.v1')") is None and 'SECRET' not in (s3.evaluate("localStorage.getItem('tl.sessions.v1')") or ''))

        # ---------- 離線 ----------
        page.goto(base)
        page.wait_for_selector('.rows .row')
        page.wait_for_function('navigator.serviceWorker.ready.then(r => !!r.active)')
        page.reload()
        page.wait_for_selector('.rows .row')
        ctx.set_offline(True)
        page.reload()
        try:
            page.wait_for_selector('.rows .row', timeout=6000)
            ok = True
        except Exception:
            ok = False
        check('安裝 service worker 後可離線開啟', ok)
        ctx.set_offline(False)

        # ---------- 深色模式(僅截圖時) ----------
        if shots:
            dctx = b.new_context(viewport={'width': 390, 'height': 844}, color_scheme='dark', locale='zh-TW', device_scale_factor=2)
            dp = dctx.new_page()
            hook(dp)
            dp.goto(base + '#/deep')
            dp.wait_for_selector('.rows .row')
            dp.click('a.row[href="#/new/role"]')
            dp.wait_for_selector('.venn')
            dp.fill('#problem', 'test')
            dp.click('button[data-act=start]')
            dp.wait_for_selector('#panel .lens')
            snap(dp, '06_dark_session')

        check('沒有 console 或頁面錯誤(含 CSP 違規)', not errors, '; '.join(errors)[:300])
        b.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--url', help='測試已部署的網址，例如 https://帳號.github.io/think-lenses/')
    ap.add_argument('--shots', help='截圖輸出資料夾')
    ap.add_argument('--headed', action='store_true', help='顯示瀏覽器視窗')
    args = ap.parse_args()

    srv = None
    if args.url:
        base = args.url if args.url.endswith('/') else args.url + '/'
    else:
        srv, base = start_server()
    shots = Path(args.shots) if args.shots else None
    if shots:
        shots.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix='think-lenses-test-'))
    print(f'測試目標：{base}\n')
    try:
        run(base, shots, args.headed, tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        if srv:
            srv.shutdown()
    fails = [r for r in results if not r[1]]
    print(f'\n共 {len(results)} 項，失敗 {len(fails)} 項')
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
