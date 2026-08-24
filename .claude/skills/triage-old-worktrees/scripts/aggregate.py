#!/usr/bin/env python3
"""aggregate.py <triage-output-dir> [main-ref]

Merge triage inputs into final-report.csv + final-report.html.

Reads from <triage-output-dir>:
  baseline-data.jsonl   (from collect-baseline.sh — one record per worktree)
  first-pass-table.md   (pipe table; last two columns used: meaningful?, summary)
  verdicts.jsonl        (authored after reading the deep-dive reports:
                         one JSON object per line:
                         {"name": "...", "verdict": "...", "confidence": "high|medium|low",
                          "land_effort": "none|tiny|small|medium|large",
                          "analysis": "1-2 sentence evidence summary",
                          "deepdive": "deep-dive/NN-topic.md"  # optional
                         })

Worktrees missing from verdicts.jsonl are derived: ancestor=YES -> in-main,
otherwise skipped-plan if the first-pass status says plan-only, else
skipped-trivial.

Writes final-report.csv and final-report.html into the same directory and
prints verdict counts. Exits non-zero if any deep-dived worktree lacks a
verdicts.jsonl entry or if row counts mismatch.

The narrative final-report.md is authored separately (hand or subagent) —
this script owns only the mechanical csv/html.
"""
import csv, html, json, subprocess, sys
from datetime import date
from pathlib import Path

VERDICTS = ('ready-landing', 'finish-work', 'in-main', 'throw-away-useless',
            'skipped-plan', 'skipped-trivial')
DIRTS = ('none', 'read-useful', 'read-litter', 'unread')
VERDICT_TO_CATEGORY = {'ready-landing': 'ready-landing', 'finish-work': 'finish-work',
                       'in-main': 'in-main', 'throw-away-useless': 'throw-away',
                       'skipped-plan': 'skipped-plan', 'skipped-trivial': 'skipped-trivial'}
COLOR = {'ready-landing': '#22c55e', 'finish-work': '#eab308', 'in-main': '#64748b',
         'throw-away-useless': '#ef4444', 'skipped-plan': '#cbd5e1', 'skipped-trivial': '#e2e8f0'}
LABEL = {'ready-landing': 'Ready for landing', 'finish-work': 'Finish work', 'in-main': 'Already in main',
         'throw-away-useless': 'Throw away', 'skipped-plan': 'Skipped (plan-only)', 'skipped-trivial': 'Skipped (trivial)'}


def main() -> int:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else 'triage-output')
    main_ref = sys.argv[2] if len(sys.argv) > 2 else 'origin/main'

    recs = {}
    for line in (out / 'baseline-data.jsonl').read_text().splitlines():
        r = json.loads(line)
        recs[r['name']] = r

    fp_summary, fp_status = {}, {}
    if (out / 'first-pass-table.md').exists():
        for line in (out / 'first-pass-table.md').read_text().splitlines():
            if not line.startswith('|') or line.startswith('| worktree') or line.startswith('|---'):
                continue
            cols = [c.strip() for c in line.strip().strip('|').split('|')]
            if len(cols) >= 9:
                fp_summary[cols[0]] = cols[8]
                fp_status[cols[0]] = cols[4]

    verdicts = {}
    if (out / 'verdicts.jsonl').exists():
        for line in (out / 'verdicts.jsonl').read_text().splitlines():
            if line.strip():
                v = json.loads(line)
                assert v['verdict'] in VERDICTS, f"bad verdict {v['verdict']} for {v['name']}"
                verdicts[v['name']] = v

    deep_dived = set()
    dd_list = out / 'worktrees-to-deep-dive.txt'
    if dd_list.exists():
        deep_dived = {l.strip() for l in dd_list.read_text().splitlines() if l.strip()}

    missing = [n for n in sorted(deep_dived) if n not in verdicts]
    if missing:
        print(f'ERROR: deep-dived worktrees missing from verdicts.jsonl: {missing}', file=sys.stderr)
        return 1

    # Hard rule: dirty worktrees need an explicit verdicts entry with a dirt
    # field — dirt is never auto-derived, because "litter" requires a read.
    dirt_warnings = []
    for name, r in recs.items():
        if isinstance(r.get('dirty'), int) and r['dirty'] > 0:
            v = verdicts.get(name)
            if v is None:
                dirt_warnings.append(f'{name}: dirty={r["dirty"]} but no verdicts.jsonl entry')
            elif v.get('dirt') in (None, 'unread'):
                dirt_warnings.append(f'{name}: dirty={r["dirty"]} but dirt is missing/unread in verdicts.jsonl')

    def dirt_of(name, r, v):
        if not isinstance(r.get('dirty'), int) or r['dirty'] == 0:
            return 'none', []
        if v is None:
            return 'unread', []
        d = v.get('dirt', 'unread')
        assert d in DIRTS, f"bad dirt {d} for {name}"
        return d, list(v.get('useful_dirt_files', []))

    rows = []
    for name, r in recs.items():
        if name in verdicts:
            v = verdicts[name]
            dv, dfiles = dirt_of(name, r, v)
            rows.append({'name': name, 'branch': r['branch'], 'date': r['date'],
                         'verdict': v['verdict'], 'confidence': v.get('confidence', 'medium'),
                         'land_effort': v.get('land_effort', 'none'),
                         'category': VERDICT_TO_CATEGORY[v['verdict']],
                         'dirt': dv, 'useful_dirt_files': dfiles,
                         'analysis': v['analysis'], 'deepdive': v.get('deepdive', ''),
                         'ahead': r['ahead'], 'behind': r['behind'], 'dirty': r['dirty']})
            continue
        if r['ancestor'] == 'YES':
            verdict, conf, eff = 'in-main', 'high', 'none'
            analysis = 'Merged (ancestor of %s). ' % main_ref
            st = fp_status.get(name, '')
            if 'dirty' in st.lower():
                analysis += 'Dirty files judged non-work: ' + st + '. '
            summ = fp_summary.get(name, '')
            for pre in ('merged: ', 'Merged: '):
                if summ.startswith(pre):
                    summ = summ[len(pre):]
            analysis += (summ[:1].upper() + summ[1:]) if summ else ''
            link = ''
        else:
            planish = 'plan' in fp_status.get(name, '').lower()
            verdict, conf, eff = ('skipped-plan' if planish else 'skipped-trivial'), 'medium', 'none'
            analysis = (fp_summary.get(name, '') + ' [' + fp_status.get(name, '') + ']').strip()
            link = ''
        dv, dfiles = dirt_of(name, r, verdicts.get(name))
        rows.append({'name': name, 'branch': r['branch'], 'date': r['date'], 'verdict': verdict,
                     'confidence': conf, 'land_effort': eff, 'category': VERDICT_TO_CATEGORY[verdict],
                     'dirt': dv, 'useful_dirt_files': dfiles,
                     'analysis': analysis, 'deepdive': link,
                     'ahead': r['ahead'], 'behind': r['behind'], 'dirty': r['dirty']})

    rows.sort(key=lambda x: x['date'], reverse=True)
    from collections import Counter
    print('verdict counts:', dict(Counter(r['verdict'] for r in rows)))
    dirt_counts = Counter(r['dirt'] for r in rows)
    print('dirt counts:', dict(dirt_counts))
    if dirt_warnings:
        print('WARNING (dirt blocks deletion-safety):', file=sys.stderr)
        for w in dirt_warnings:
            print('  - ' + w, file=sys.stderr)

    with open(out / 'final-report.csv', 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['num', 'worktree', 'branch', 'date', 'verdict', 'confidence',
                    'land_effort', 'category', 'dirt', 'analysis'])
        for i, r in enumerate(rows, 1):
            useful = (' [useful dirt: ' + '; '.join(r['useful_dirt_files']) + ']') if r['useful_dirt_files'] else ''
            w.writerow([i, r['name'], r['branch'], r['date'], r['verdict'], r['confidence'],
                        r['land_effort'], r['category'], r['dirt'], r['analysis'] + useful])

    # HTML ------------------------------------------------------------------
    repo_root = subprocess.run(['git', 'rev-parse', '--show-toplevel'],
                               capture_output=True, text=True).stdout.strip()
    main_sha = subprocess.run(['git', 'rev-parse', '--short=9', main_ref],
                              capture_output=True, text=True).stdout.strip()
    counts = {k: sum(1 for r in rows if r['verdict'] == k) for k in LABEL}
    cards = ''.join(
        f'<div class="card" style="border-top-color:{COLOR[k]}"><div class="n">{v}</div>'
        f'<div class="l">{LABEL[k]}</div></div>' for k, v in counts.items())
    trs = []
    for i, r in enumerate(rows, 1):
        dd = f' · <a href="{html.escape(r["deepdive"])}">deep dive</a>' if r['deepdive'] else ''
        dfiles = (f'<div class="dfiles">useful: {html.escape("; ".join(r["useful_dirt_files"]))}</div>'
                  if r['useful_dirt_files'] else '')
        trs.append(
            f'<tr data-verdict="{r["verdict"]}"><td class="num">{i}</td>'
            f'<td class="mono">{html.escape(r["name"])}</td>'
            f'<td class="mono sm">{html.escape(r["branch"])}</td><td>{r["date"]}</td>'
            f'<td><span class="pill" style="background:{COLOR[r["verdict"]]}">{r["verdict"]}</span></td>'
            f'<td>{r["confidence"]}</td><td>{r["land_effort"]}</td>'
            f'<td class="dirt-{r["dirt"]}">{r["dirt"]}{dfiles}</td>'
            f'<td class="num">{r["ahead"]}</td><td class="num">{r["behind"]}</td>'
            f'<td class="num">{r["dirty"]}</td><td>{html.escape(r["analysis"])}{dd}</td></tr>')

    banner = ''
    n_unread = sum(1 for r in rows if r['dirt'] == 'unread')
    if n_unread:
        banner = (f'<div class="banner">⚠ {n_unread} worktree(s) have '
                  f'<b>unread dirt</b> — not deletion-safe until every dirty file has been read '
                  f'(see dirt-report).</div>')

    html_doc = HTPL.replace('__CARDS__', cards).replace('__TRS__', ''.join(trs)) \
        .replace('__DATA__', json.dumps(rows)).replace('__LABELS__', json.dumps(LABEL)) \
        .replace('__COLORS__', json.dumps(COLOR)).replace('__BANNER__', banner) \
        .replace('__TITLE__', f'Worktree triage - {date.today().isoformat()}') \
        .replace('__META__', html.escape(
            f'repo: {repo_root} · main: {main_ref} @ {main_sha} · {len(rows)} worktrees audited · '
            'full narrative in final-report.md'))
    (out / 'final-report.html').write_text(html_doc)
    print(f'wrote {out}/final-report.csv and {out}/final-report.html')
    return 0


HTPL = '''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>
 body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 2rem; color: #0f172a; background: #f8fafc; }
 h1 { font-size: 1.4rem; } .meta { color: #475569; font-size: .85rem; margin-bottom: 1.25rem; }
 .cards { display: flex; flex-wrap: wrap; gap: .75rem; margin-bottom: 1.5rem; }
 .card { background: #fff; border: 1px solid #e2e8f0; border-top: 4px solid #999; border-radius: 8px; padding: .6rem 1rem; min-width: 130px; }
 .card .n { font-size: 1.5rem; font-weight: 700; } .card .l { font-size: .8rem; color: #475569; }
 .controls { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; margin-bottom: .8rem; }
 .controls input[type=search] { padding: .4rem .6rem; border: 1px solid #cbd5e1; border-radius: 6px; width: 260px; }
 .controls button { border: 1px solid #cbd5e1; background: #fff; border-radius: 6px; padding: .35rem .7rem; cursor: pointer; font-size: .82rem; }
 .controls button.active { background: #0f172a; color: #fff; border-color: #0f172a; }
 table { border-collapse: collapse; width: 100%; background: #fff; font-size: .82rem; }
 th, td { border: 1px solid #e2e8f0; padding: .38rem .5rem; text-align: left; vertical-align: top; }
 th { background: #f1f5f9; cursor: pointer; user-select: none; position: sticky; top: 0; }
 th .arrow { color: #94a3b8; font-size: .7rem; }
 tr:hover td { background: #f8fafc; }
 .pill { color: #fff; border-radius: 999px; padding: .1rem .55rem; font-size: .75rem; white-space: nowrap; }
 tr[data-verdict="skipped-plan"] .pill, tr[data-verdict="skipped-trivial"] .pill { color: #334155; }
 .dirt-none { color: #94a3b8; } .dirt-read-litter { color: #64748b; }
 .dirt-read-useful { color: #15803d; font-weight: 600; }
 .dirt-unread { color: #b45309; font-weight: 700; }
 .dfiles { font-size: .72rem; color: #15803d; font-weight: 400; margin-top: .15rem; }
 .banner { background: #fef3c7; border: 1px solid #f59e0b; border-radius: 8px; padding: .6rem .9rem; margin-bottom: 1rem; font-size: .9rem; }
 .mono { font-family: ui-monospace, monospace; font-size: .78rem; } .sm { font-size: .72rem; color: #475569; }
 .num { text-align: right; }
</style>
</head>
<body>
<h1>__TITLE__</h1>
<div class="meta">__META__</div>
<div class="cards">__CARDS__</div>
__BANNER__
<div class="controls">
 <label for="q">Filter: <input type="search" id="q" placeholder="worktree, branch, analysis&hellip;"></label>
 <span id="vfilters"></span>
</div>
<table id="t">
<thead><tr>
<th data-k="num"># <span class="arrow"></span></th><th data-k="name">worktree <span class="arrow"></span></th>
<th data-k="branch">branch <span class="arrow"></span></th><th data-k="date">date <span class="arrow"></span></th>
<th data-k="verdict">verdict <span class="arrow"></span></th><th data-k="confidence">confidence <span class="arrow"></span></th>
<th data-k="land_effort">land effort <span class="arrow"></span></th><th data-k="dirt">dirt <span class="arrow"></span></th>
<th data-k="ahead">ahead <span class="arrow"></span></th>
<th data-k="behind">behind <span class="arrow"></span></th><th data-k="dirty">dirty <span class="arrow"></span></th>
<th data-k="analysis">analysis <span class="arrow"></span></th>
</tr></thead>
<tbody>__TRS__</tbody>
</table>
<script>
const data = __DATA__;
const LABELS = __LABELS__, COLORS = __COLORS__;
const tbl = document.getElementById('t');
const tbody = tbl.querySelector('tbody');
const q = document.getElementById('q');
let sortKey = 'date', sortDir = -1, vfilter = null;
const vf = document.getElementById('vfilters');
['all'].concat(Object.keys(LABELS)).forEach(v => {
  const b = document.createElement('button');
  b.textContent = v === 'all' ? 'all (' + data.length + ')' : v + ' (' + data.filter(d=>d.verdict===v).length + ')';
  b.dataset.v = v;
  if (v === 'all') b.classList.add('active');
  b.addEventListener('click', () => {
    vfilter = v === 'all' ? null : v;
    vf.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    render();
  });
  vf.appendChild(b);
});
function render() {
  const needle = q.value.toLowerCase();
  let rows = data.filter(d => (!vfilter || d.verdict === vfilter) &&
    (!needle || (d.name + ' ' + d.branch + ' ' + d.analysis).toLowerCase().includes(needle)));
  const k = sortKey;
  rows.sort((a,b) => (typeof a[k] === 'number' ? a[k]-b[k] : String(a[k]).localeCompare(String(b[k]))) * sortDir);
  tbody.innerHTML = rows.map((d,i) => {
    const dd = d.deepdive ? ' &middot; <a href="' + d.deepdive + '">deep dive</a>' : '';
    const c = COLORS[d.verdict];
    const dark = d.verdict.startsWith('skipped') ? ' style="background:'+c+';color:#334155"' : ' style="background:'+c+'"';
    const df = (d.useful_dirt_files && d.useful_dirt_files.length)
      ? '<div class="dfiles">useful: ' + esc(d.useful_dirt_files.join('; ')) + '</div>' : '';
    return '<tr><td class="num">'+(i+1)+'</td><td class="mono">'+esc(d.name)+'</td><td class="mono sm">'+esc(d.branch)+'</td><td>'+d.date+
      '</td><td><span class="pill"'+dark+'>'+d.verdict+'</span></td><td>'+d.confidence+'</td><td>'+d.land_effort+
      '</td><td class="dirt-'+d.dirt+'">'+d.dirt+df+'</td><td class="num">'+d.ahead+'</td><td class="num">'+d.behind+'</td><td class="num">'+d.dirty+'</td><td>'+esc(d.analysis)+dd+'</td></tr>';
  }).join('');
}
function esc(s){ const e = document.createElement('span'); e.textContent = s; return e.innerHTML; }
q.addEventListener('input', render);
tbl.querySelectorAll('th').forEach(th => th.addEventListener('click', () => {
  const k = th.dataset.k;
  if (k === sortKey) sortDir *= -1; else { sortKey = k; sortDir = 1; }
  tbl.querySelectorAll('th .arrow').forEach(a => a.textContent = '');
  th.querySelector('.arrow').textContent = sortDir === 1 ? '\\u25b2' : '\\u25bc';
  render();
}));
render();
</script>
</body>
</html>'''

if __name__ == '__main__':
    sys.exit(main())
