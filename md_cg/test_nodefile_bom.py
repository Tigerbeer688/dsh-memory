# -*- coding: utf-8 -*-
"""nodefile.loads 的 UTF-8 BOM 容忍（2026-10-07 读面失明事故回归）。

背景：一次批量重写给 151 个 .md 加了 UTF-8 BOM，`loads` 要求 text 以
"---\\n" 起始 → 解析失败返回 ({}, 原文) → frontmatter（id/tags/importance）
整体丢失、score 恒 0.000、judge 一律 DEFER → 109/110 条已确认教训从召回
中整体消失。读面必须在判起始条件前剥 BOM，其余解析口径不变。

约束：dumps→loads 往返不变（无 BOM 路径零行为变更）。
"""
from __future__ import annotations

from md_cg import nodefile


def main() -> None:
    body = "---\nid: mem_x\ntags: [\"correction\", \"已确认教训\"]\nimportance: 0.9\n---\n# 功能名 追高教训\n正文\n"

    # ① 无 BOM 正路：行为不变
    fm, ct = nodefile.loads(body)
    assert fm.get("id") == "mem_x", fm
    assert fm.get("tags") == ["correction", "已确认教训"], fm
    assert fm.get("importance") == 0.9, fm
    assert ct.startswith("# 功能名 追高教训"), repr(ct[:30])

    # ② BOM + 合法格式：frontmatter 必须解析出来，content 不残留 BOM
    fm2, ct2 = nodefile.loads("\ufeff" + body)
    assert fm2.get("id") == "mem_x", "BOM 剥离失败，frontmatter 会整体丢失"
    assert not ct2.startswith("\ufeff"), repr(ct2[:12])
    assert ct2.startswith("# 功能名 追高教训"), repr(ct2[:30])

    # ③ BOM + 非法格式：返回 ({}, 剥掉 BOM 的原文)，不把 BOM 留进 content
    fm3, ct3 = nodefile.loads("\ufeff没有分隔符的普通文本")
    assert fm3 == {}, fm3
    assert ct3 == "没有分隔符的普通文本", repr(ct3)

    # ④ 往返不变：dumps 产物走原路径（无 BOM）
    fm4, ct4 = nodefile.loads(nodefile.dumps({"id": "mem_y", "access_count": 3}, "# 头\n正文"))
    assert fm4.get("id") == "mem_y", fm4
    assert fm4.get("access_count") == 3, fm4

    print("PASS nodefile BOM tolerance (4 cases)")


if __name__ == "__main__":
    main()
