# -*- coding: utf-8 -*-
"""召回生产面验收仪器（只读，record=False，零写入）。

用途：P1/P2 修复后的数字验收与日后回归抽查——10 组生产查询跑
cg.search（生产面，含 judge）与 search_rrf（semantic 对照），逐组打印：
  inj      = code_/doc_ 剔除且 score>=0.1 的注入候选数（hooks 实际可注入面）
  cor_inj  = 注入候选里的已确认教训条数
  hr5      = top5 中铁律占比（验 HR 霸榜是否收敛）
  acc      = ACCEPT 裁决数
  bl       = 命中日志黑名单靶子的注入候选（hooks 按正文 ## yyyy-mm-dd 挡、correction 豁免）
  sem      = semantic 单路与对 base 的独有增量（验零区分度是否仍在）

用法：python scripts/probe_recall_live.py（仓库根执行；不改任何状态）。
"""
import io
import json
import pathlib
import re
import sys
import time

repo_root = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(repo_root))
from md_cg.mdcos import MdCGSecure  # noqa: E402

root = json.load(io.open(str(repo_root / "data" / "paths.json"), encoding="utf-8"))["root"]
cg = MdCGSecure(root, principal=None, autoflush=1)

# 日志黑名单靶子：正文含以 ## yyyy 开头的行的节点
bl = []
for p in (pathlib.Path(root) / "knowledge").rglob("*.md"):
    try:
        t = p.read_text(encoding="utf-8")
    except Exception:
        continue
    if re.search(r"^##\s*\d{4}-", t, re.M):
        bl.append(p.stem)
BL = set(bl)
print("BLACKLIST_CAND", len(bl), " ".join(sorted(bl)))


def U(r):
    """normalize: search returns (node, score, judge) tuples; path outputs are (dict, score)."""
    if isinstance(r, (tuple, list)):
        n = r[0] if r else {}
        try:
            s = float(r[1] or 0) if len(r) > 1 else 0.0
        except Exception:
            s = 0.0
        q = r[2] if len(r) > 2 else {}
        if not isinstance(q, dict):
            q = {}
        return (n if isinstance(n, dict) else {}), s, q
    if isinstance(r, dict):
        try:
            s = float(r.get("score") or 0)
        except Exception:
            s = 0.0
        q = r.get("state")
        return r, s, ({"state": q} if q else {})
    return {}, 0.0, {}


def tags(r):
    n, _, _ = U(r)
    fm = n.get("frontmatter") or {}
    tg = fm.get("tags") or []
    if isinstance(tg, str):
        try:
            tg = json.loads(tg)
        except Exception:
            tg = [tg]
    return tg


def idof(r):
    n, _, _ = U(r)
    return n.get("id") or n.get("path") or "?"


def sc(r):
    return U(r)[1]


def ishr(r):
    return any(x in ("hard_rule", "铁律") for x in tags(r))


def iscor(r):
    return any(x in ("correction", "已确认教训") for x in tags(r))


def st(r):
    _, _, q = U(r)
    return q.get("state") or "-"


QS = ["复盘：这周交易有什么问题", "追高买入之后止损怎么设", "仓位管理有什么经验教训",
      "板块轮动期该做什么", "期权到期忘了行权怎么办", "为什么总是卖飞龙头股",
      "止盈止损纪律有哪些", "市场大跌时应该怎么做", "情绪化交易的后果", "今天的复盘要点"]
BASE = ("lexical", "bucket", "entity", "graph", "chain", "temporal")

for i, q0 in enumerate(QS, 1):
    q = q0 + " 教训 经验 错误"
    t0 = time.time()
    ra, ma = cg.search(q, layer="knowledge", k=16, record=False)
    dt = round((time.time() - t0) * 1000)
    pool = [r for r in ra if not idof(r).startswith(("code_", "doc_"))]
    inj = [r for r in pool if sc(r) >= 0.1]
    top5 = pool[:5]
    B, mb = cg.search_rrf(q, layer="knowledge", k=16, paths=BASE + ("semantic",), record=False)
    C, mc = cg.search_rrf(q, layer="knowledge", k=16, paths=BASE, record=False)
    D, md = cg.search_rrf(q, layer="knowledge", k=16, paths=("semantic",), record=False)
    idsC = {idof(r) for r in C}
    uniq = [r for r in B if idof(r) not in idsC]

    def f(pred, rs):
        rs = list(rs)
        return round(sum(1 for r in rs if pred(r)) / max(1, len(rs)), 2)

    print("Q%02d ms=%d inj=%d hr5=%.1f cor_inj=%d acc=%d maxA=%.3f bl=%s" % (
        i, dt, len(inj), f(ishr, top5), sum(1 for r in inj if iscor(r)),
        sum(1 for r in pool if st(r) == "ACCEPT"),
        max([sc(r) for r in pool] or [0]),
        ",".join(idof(r)[:14] for r in inj if idof(r) in BL) or "-"))
    print("   top3: " + " | ".join("%s %.3f %s%s" % (
        idof(r)[:14], sc(r), "HR" if ishr(r) else ("COR" if iscor(r) else "OTH"),
        "" if st(r) == "-" else "/" + st(r)) for r in pool[:3]))
    print("   sem: semPath=%d uniq=%d uniq_cor=%d maxB=%.4f perpath=%s" % (
        len(D), len(uniq), sum(1 for r in uniq if iscor(r)),
        max([sc(r) for r in B] or [0]),
        json.dumps(mb.get("per_path") or {}, ensure_ascii=False, default=str)[:200]))
    if uniq:
        print("   uniq: " + " | ".join("%s%s" % (
            idof(r)[:14], "COR" if iscor(r) else ("HR" if ishr(r) else "OTH")) for r in uniq[:6]))
print("DONE")
