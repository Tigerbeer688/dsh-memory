# -*- coding: utf-8 -*-
"""lingshu 语料 BOM 零容忍门禁（2026-10-07 事故的防复发闸）。

背景：151 个 .md 被批量写成 UTF-8 BOM → nodefile.loads 解析失败 →
frontmatter 丢失 → 109/110 教训召回归零。写入面为何带出 BOM 至今未定位
（lingshu 无 git 追踪），故在测试侧设硬门禁：语料里任何 .md 带 BOM 即红。

生效条件：data/paths.json 存在且 root 为真实目录才扫描；否则显式 SKIP
（无语料机器上不误伤，CI/本机即门禁）。
"""
from __future__ import annotations

import io
import json
import os
import pathlib


def main() -> None:
    here = pathlib.Path(__file__).resolve()
    paths_file = here.parent.parent / "data" / "paths.json"
    if not paths_file.exists():
        print("SKIP corpus BOM gate: data/paths.json 不存在")
        return
    root = json.load(io.open(paths_file, encoding="utf-8")).get("root")
    if not root or not os.path.isdir(root):
        print("SKIP corpus BOM gate: root 不可用: %s" % root)
        return

    total, bad = 0, []
    for p in sorted(pathlib.Path(root).rglob("*.md")):
        total += 1
        try:
            with open(p, "rb") as fh:
                if fh.read(3) == b"\xef\xbb\xbf":
                    bad.append(str(p))
        except OSError as e:
            bad.append("%s (读失败: %s)" % (p, e))
    assert not bad, (
        "语料中存在 %d/%d 个带 BOM 或不可读的 .md——读面 frontmatter 会整体丢失"
        "（2026-10-07 事故形态）: %s" % (len(bad), total, bad[:5])
    )
    print("PASS corpus BOM gate: %d .md 全部无 BOM (root=%s)" % (total, root))


if __name__ == "__main__":
    main()
