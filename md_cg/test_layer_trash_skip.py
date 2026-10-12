# -*- coding: utf-8 -*-
"""test_layer_trash_skip.py · 层内 _trash 不进索引/候选（B1+B2 回归锚）。

现场：一次性运维脚本把文件搬进 `knowledge/_trash/<批次>/` 而不走 forget API
（正式 trash 在根级 `trash/`，不在 LAYERS）；`_scan_nodes` 用 os.walk 递归
扫层目录，把 trash 文件当正常 knowledge 节点收录——lifecycle_state 仍是
active（搬文件不改 frontmatter），`_candidates` 只滤 archived，于是 93 条
幽灵留在候选池被高频召回（实测 ac 最高 809）。

修复锚点（本守卫的红绿判据）：
  B1a `_scan_nodes` 剪 LAYER_SKIP_DIRS（`_trash`）——全量重建不再收录；
  B1b `_count_md_files` 同口径剪——否则 compact 计数对账永久失配；
  B1c `_dir_fingerprint` 同口径剪——否则 trash 目录 mtime 变化触发无谓重扫；
  B1d `reconcile._scan_disk` 同口径剪——否则 reconcile 把幽灵判成 missing
       又 _stage 回来（幽灵复活）；
  B2  `_candidates` path 含 `/_trash/` 兜底——存量索引未 rebuild 前也滤掉。

隔离纪律：tempfile.mkdtemp 库 + 哑 Principal；测毕 rmtree。
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

from . import reconcile
from .mdcg import LAYER_SKIP_DIRS
from .mdcos import MdCGOS

PASS, FAIL = 0, 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [ok] {name}")
    else:
        FAIL += 1
        print(f"  [FAIL] {name}  {detail}")


def _write_md(root, rel, nid, body="body"):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(f"---\nid: {nid}\nlayer: knowledge\n---\n{body}\n")
    return p


def main():
    check("LAYER_SKIP_DIRS 含 _trash", "_trash" in LAYER_SKIP_DIRS,
          f"LAYER_SKIP_DIRS={LAYER_SKIP_DIRS}")

    root = tempfile.mkdtemp(prefix="mdcg_trash_")
    try:
        # 正常节点 + 层内 _trash 幽灵（模拟手搬产物：文件在、lifecycle 未 stamp）
        _write_md(root, "knowledge/orphan/ok1.md", "ok1")
        _write_md(root, "knowledge/_trash/batch1/ghost1.md", "ghost1")
        _write_md(root, "knowledge/_trash/batch2/ghost2.md", "ghost2")

        cg = MdCGOS(root)
        try:
            # B1a: _scan_nodes 不收录 _trash
            check("B1a _scan_nodes 不含 ghost1", "ghost1" not in cg.index["nodes"],
                  f"nodes={list(cg.index['nodes'])}")
            check("B1a _scan_nodes 不含 ghost2", "ghost2" not in cg.index["nodes"])
            check("B1a _scan_nodes 含 ok1", "ok1" in cg.index["nodes"])

            # B1b: _count_md_files 只数非 trash
            n = cg._count_md_files()
            check("B1b _count_md_files==1（只数 ok1）", n == 1, f"n={n}")

            # B2: _candidates 滤 path 含 /_trash/（即使索引被人为塞进幽灵）
            cg.index["nodes"]["ghost_in_idx"] = {
                "path": "knowledge/_trash/batch1/ghost_in_idx.md",
                "layer": "knowledge", "role": "user",
            }
            cands = cg._candidates()
            cand_ids = {e.get("path", "") for e in cands}
            check("B2 _candidates 不含 /_trash/ path",
                  not any("/_trash/" in p for p in cand_ids),
                  f"paths sample={list(cand_ids)[:5]}")
            check("B2 _candidates 仍含 ok1 path",
                  any(p.endswith("ok1.md") for p in cand_ids))
            # 清掉人为塞的条目，不影响后续
            cg.index["nodes"].pop("ghost_in_idx", None)

            # B1c: rebuild 后索引仍无幽灵（_scan_nodes 全量路径）
            cg.rebuild_index()
            check("B1c rebuild 后无 ghost1", "ghost1" not in cg.index["nodes"])
            check("B1c rebuild 后有 ok1", "ok1" in cg.index["nodes"])

            # B1d: reconcile._scan_disk 不扫 _trash——幽灵文件在盘但不进 by_nid
            by_nid, path_owner, problems = reconcile._scan_disk(cg)
            check("B1d _scan_disk 不含 ghost1", "ghost1" not in by_nid,
                  f"by_nid keys={list(by_nid)[:5]}")
            check("B1d _scan_disk 含 ok1", "ok1" in by_nid)

            # 端到端：人为把幽灵塞回索引 → reconcile apply 应摘除（判 ghost）
            cg.index["nodes"]["ghost1"] = {
                "path": "knowledge/_trash/batch1/ghost1.md",
                "layer": "knowledge", "role": "user",
            }
            rep = reconcile.reconcile_state(cg, apply=True)
            check("B1d reconcile 判 ghost1 为幽灵",
                  "ghost1" in rep.get("ghost_entries", []),
                  f"ghost={rep.get('ghost_entries')}")
            check("B1d reconcile apply 后索引无 ghost1",
                  "ghost1" not in cg.index["nodes"])
        finally:
            cg.close()
    finally:
        shutil.rmtree(root, ignore_errors=True)

    total = PASS + FAIL
    print(f"\n{PASS}/{total} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
