---
description: 執行 openspec/changes/tasks.md 中的所有任務
---

請讀取 openspec/changes/tasks.md，依序執行所有任務。

規則：
- 先讀取 .claude/memory/MEMORY.md 和 CLAUDE.md
- 每完成一個任務，在 tasks.md 標記 ✅
- 每個任務完成後跑 bash scripts/qa_check.sh
- 全部完成後跑 npm test
- 最後 git checkout dev → commit → push → 合併 main
- 所有回應用繁體中文

$ARGUMENTS
