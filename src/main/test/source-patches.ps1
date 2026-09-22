$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$script = [IO.File]::ReadAllText((Join-Path $ProjectRoot 'build.ps1'))
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($script, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Invalid build PowerShell' }
foreach ($name in @('Assert-ChildPath', 'Remove-Managed', 'Invoke-Checked', 'Get-AppliedSourcePatches', 'Update-LegacyMinimalUiPatch')) {
    $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    . ([scriptblock]::Create($definition.Extent.Text))
}
$patchNames = @('core-ui.patch', 'minimal-ui.patch', 'editor-layout.patch', 'conversation-chrome.patch', 'terminal-panel.patch', 'startup-ui.patch', 'session-list.patch', 'panel-ui.patch', 'sidebar-mode.patch', 'session-workspace.patch', 'source-compile-fixes.patch', 'sidebar-size.patch', 'theme-startup.patch', 'explorer-editing.patch')
$checkout = Join-Path $ProjectRoot 'vendor\vscode'
$cache = Join-Path $ProjectRoot '.cache'
$fixture = Join-Path $cache ('.patch-test-' + [Guid]::NewGuid().ToString('N'))
$git = (Get-Command git -ErrorAction Stop).Source
$encoding = [Text.UTF8Encoding]::new($false)
New-Item -ItemType Directory -Force -Path $fixture | Out-Null
try {
    Invoke-Checked $git @('init', '--quiet', $fixture)
    foreach ($name in $patchNames) {
        foreach ($line in [IO.File]::ReadAllLines((Join-Path $ProjectRoot "resources\$name"))) {
            if (-not $line.StartsWith('+++ b/')) { continue }
            $relative = $line.Substring(6)
            $target = Join-Path $fixture $relative
            Assert-ChildPath $target $fixture
            if (Test-Path -LiteralPath $target) { continue }
            # cmdlet redirection can change encoding in Windows PowerShell.
            $output = & $git -c "safe.directory=$checkout" -C $checkout show "HEAD:$relative"
            if ($LASTEXITCODE -ne 0) { throw "Cannot read pinned source: $relative" }
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
            [IO.File]::WriteAllText($target, ($output -join "`n") + "`n", $encoding)
        }
    }
    if ((Get-AppliedSourcePatches $fixture $patchNames).Count -ne 0) { throw 'Pristine sources were marked patched' }
    foreach ($name in $patchNames[0..7]) { Invoke-Checked $git @('-C', $fixture, 'apply', (Join-Path $ProjectRoot "resources\$name")) }
    if ((Get-AppliedSourcePatches $fixture $patchNames).Count -ne 8) { throw 'Partial patch stack not recognized' }
    foreach ($name in $patchNames[8..($patchNames.Count - 1)]) { Invoke-Checked $git @('-C', $fixture, 'apply', (Join-Path $ProjectRoot "resources\$name")) }
    if ((Get-AppliedSourcePatches $fixture $patchNames).Count -ne $patchNames.Count) { throw 'Overlapping patch stack not recognized' }
    $actions = Join-Path $fixture 'src\vs\platform\actions\common\actions.ts'
    $custom = [IO.File]::ReadAllText($actions) + "`n// user change outside patch hunks`n"
    [IO.File]::WriteAllText($actions, $custom, $encoding)
    if ((Get-AppliedSourcePatches $fixture $patchNames).Count -ne $patchNames.Count) { throw 'Unrelated edits prevented patch detection' }
    if ([IO.File]::ReadAllText($actions) -cne $custom) { throw 'Detection mutated source' }
    $commands = "'ubovm.validateCodeChanges', 'ubovm.attachSelection', 'ubovm.reviewCodeChanges', "
    [IO.File]::WriteAllText($actions, $custom.Replace($commands, ''), $encoding)
    $minimal = Join-Path $ProjectRoot 'resources\minimal-ui.patch'
    if (-not (Update-LegacyMinimalUiPatch $fixture $minimal)) { throw 'Known legacy patch not upgraded' }
    if ([IO.File]::ReadAllText($actions) -cne $custom) { throw 'Upgrade failed to preserve unrelated edits' }
    if (Update-LegacyMinimalUiPatch $fixture $minimal) { throw 'Current patch was upgraded twice' }
    $conflict = $custom.Replace($commands, '').Replace("'ubovm.toggleTheme',", "'user.customCommand',")
    [IO.File]::WriteAllText($actions, $conflict, $encoding)
    if (Update-LegacyMinimalUiPatch $fixture $minimal) { throw 'Unknown conflict was silently overwritten' }
    if ([IO.File]::ReadAllText($actions) -cne $conflict) { throw 'Conflict check changed source' }
    Write-Host '[OK] Pristine, partial, overlapping, legacy, repeat, and conflict cases passed; local edits preserved.'
} finally { Remove-Managed $fixture $cache }
