$file = 'components\ensemble\ensemble-app.tsx'
$c = Get-Content $file -Raw -Encoding UTF8

$marker_start = 'const systemPrompt = `'
$marker_rule_old = '=== 行文规范（硬性，违反即视为错误）==='

# 找到 systemPrompt 赋值开始的位置
$startIdx = $c.IndexOf('const systemPrompt = `')
if ($startIdx -lt 0) { Write-Host 'CANNOT_FIND_systemPrompt'; exit 1 }

# 找到行文规范段的开始（第一条 1. 动作...）
$ruleStart = $c.IndexOf('像写小说长文一样自然行文', $startIdx)
if ($ruleStart -lt 0) { Write-Host 'CANNOT_FIND_rule_start'; exit 1 }

# 找到行文规范段结束（紧接着的选角部分前面的分隔线）
$ruleEnd = $c.IndexOf('= 选角：这一幕谁上场', $ruleStart)
if ($ruleEnd -lt 0) { Write-Host 'CANNOT_FIND_rule_end'; exit 1 }
# 找回行首的=号位置
$lineStart = $c.LastIndexOf("`n", $ruleEnd) + 1

$oldBlock = $c.Substring($ruleStart, $lineStart - $ruleStart)

$newBlock = @'
每个出场角色用一行 [角色名]: 起头（半角方括号 + 半角冒号），例如：
   [金成帝]:
   他抬眼扫过来，语气压得很低。
   `"别动。`"
   这人又在硬撑。
   [岳霖玉]:
   指尖一颤，笔尖停在纸上。
   `"我……我自己来。`"

1. 叙述 / 动作 / 神态 / 环境描写：直接写成叙述句，不加任何符号。
2. 中文台词：必须用英文双引号包裹，例如 `"别动。`"。台词单独成段。
3. 韩语台词：用「」包裹，下一行紧接无引号中文翻译。
   例：
   「너 왜 여기 있어?」
   你为什么在这里?
4. 心理活动：直接写成叙述句，不加任何符号。
5. 严禁使用：（）、【】、*、《》、#、~；严禁 Markdown 标题、序号列表。
${bilingualBlock}
'@

$c2 = $c.Replace($oldBlock, $newBlock)
if ($c2 -eq $c) { Write-Host "BLOCK2_NOT_FOUND: old=[$oldBlock]"; exit 1 }
Write-Host 'BLOCK2_OK'
Set-Content $file -Value $c2 -Encoding UTF8 -NoNewline
