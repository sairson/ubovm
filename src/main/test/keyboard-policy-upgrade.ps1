$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $ProjectRoot 'build.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Replace-CoreSnippet', 'Get-PatchAdditions', 'Update-ManagedKeyboardPolicy', 'Assert-CurrentKeyboardPolicy')) {
    $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    . ([scriptblock]::Create($definition.Extent.Text))
}
$legacy = (Get-PatchAdditions (Join-Path $ProjectRoot 'resources/patches/keyboard-policy.patch') 'src/vs/platform/keybinding/common/abstractKeybindingService.ts').Replace('resolveResult.commandId', 'l.commandId')
$search = Get-PatchAdditions (Join-Path $ProjectRoot 'resources/patches/file-search.patch') 'src/vs/platform/keybinding/common/abstractKeybindingService.ts'
$current = [regex]::Replace($legacy, '(?m)^.*if \(/\^\(\?:workbench.*\{\r?$', $search.TrimEnd())
$prefix = 'this._currentlyDispatchingCommandId=l.commandId;' + "`n"
$expected = 'BEFORE' + $prefix + $current + 'try{AFTER'
$olderSearch = [regex]::Replace($current, '(?m)^\t+const fileSearch = /[^\r\n;]+/;', "`t`t`t`t`tconst fileSearch = /^(?:search\.)/;")
foreach ($policy in @($legacy, $olderSearch, $current)) {
    $actual = Update-ManagedKeyboardPolicy ('BEFORE' + $prefix + $policy + 'try{AFTER') $legacy $current
    if ($actual -cne $expected) { throw 'Migration changed unrelated text or missed the current policy.' }
    if ((Update-ManagedKeyboardPolicy $actual $legacy $current) -cne $expected) { throw 'Migration is not idempotent.' }
}
foreach ($policy in @($legacy.Replace('return true;', 'return false;'), ($legacy + $legacy))) {
    $rejected = $false
    try { [void](Update-ManagedKeyboardPolicy ($prefix + $policy + 'try{') $legacy $current) } catch { $rejected = $true }
    if (!$rejected) { throw 'Unknown keyboard behavior must be rejected.' }
}
foreach ($duplicate in @(($expected + $expected), ($expected + $prefix + $legacy + 'try{'))) {
    $rejected = $false
    try { [void](Update-ManagedKeyboardPolicy $duplicate $legacy $current) } catch { $rejected = $true }
    if (!$rejected) { throw 'Duplicate dispatch anchors must be rejected even when one is current.' }
}
Write-Host '[OK] Legacy and search policy upgrades, idempotence, unknown-policy and duplicate-anchor rejection'
Assert-CurrentKeyboardPolicy $expected $legacy $current
foreach ($policy in @($legacy, $olderSearch)) {
    $rejected = $false
    try { Assert-CurrentKeyboardPolicy ($prefix + $policy + 'try{') $legacy $current } catch { $rejected = $true }
    if (!$rejected) { throw 'Read-only runtime check must reject stale policy.' }
}
Write-Host '[OK] Read-only runtime check accepts current policy and rejects stale policies'
