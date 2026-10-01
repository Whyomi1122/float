# 群像模式（Ensemble）开发注意事项

## ⚠️ 编码铁律（血泪教训）

本仓库源码含大量中文，**所有写文件操作必须走 UTF-8 安全通道**：

1. **禁止**用 PowerShell 的 `Set-Content` / `Out-File` / `>` 重定向改写源码文件 —— 默认编码不是 UTF-8，会把中文写成乱码，而且 git diff 里不一定一眼看得出来。
2. 批量改动**必须用 Node 脚本**：
   `fs.readFileSync(path, "utf8")` → 字符串替换 → `fs.writeFileSync(path, src, "utf8")`。
3. **改动前先探测换行符**：本仓库源码是 **CRLF**。Node 脚本里先归一化成 LF 做匹配，写回时还原 CRLF，否则多行匹配会全部失败（表现为「期望命中 1 次，实际 0 次」）。
4. **每次批量改完立刻校验中文**：
   数一下 CJK 字符段数量，数字骤降即说明编码已损坏。
5. **一旦损坏，不要手工修补**：先 `git log` 找到中文完好的提交，
   `git checkout <sha> -- <file>` 恢复，再用 Node 脚本重新打补丁。
6. 补丁脚本写成**可重复执行的独立文件**（如 `scripts/apply-*.mjs`），
   每步替换都做「命中次数 === 1」断言，失败即中止，不要静默跳过。

## 群像模式（Ensemble）结构速查

- 主界面：`components/ensemble/ensemble-app.tsx`（剧本列表 / 创建 / 剧场 三视图）
- 功能面板：`components/ensemble/ensemble-tools-sheet.tsx`（输入区 ＋ 号打开的 TOOLS 面板）
- 存储层：`lib/ensemble-storage.ts`（key: `float_ensemble_scripts_v1`）
- API 级联：`resolveEnsembleApiConfig(characterId, scriptOverrideId)`
  优先级：剧本级覆盖 → 全局默认 → 角色默认 → 群像 app 覆盖
- 三色体系：`GS_COLORS`（灰阶梯度：对白深黑 / 动作深灰 / 心理浅灰），
  剧本级覆盖走 `resolvePalette(script.palette)`
