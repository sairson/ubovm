$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$script = [IO.File]::ReadAllText((Join-Path $ProjectRoot 'build.ps1'))
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($script, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Invalid build PowerShell' }
foreach ($name in @('Assert-ChildPath', 'Remove-Managed', 'Invoke-Checked', 'Get-SourcePatchNames', 'Get-AppliedSourcePatches', 'Update-LegacyMinimalUiPatch', 'Update-LegacySidebarCloseTabsPatch', 'Update-LegacySidebarModePatch')) {
    $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    . ([scriptblock]::Create($definition.Extent.Text))
}
# Exercise the actual build stack, including newly introduced upgrade patches.
$assignment = $ast.Find({ param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$PatchNames' }, $true)
$patchNames = @(([scriptblock]::Create($assignment.Right.Extent.Text)).Invoke())
$checkout = Join-Path $ProjectRoot 'vendor\vscode'
$cache = Join-Path $ProjectRoot '.cache'
$fixture = Join-Path $cache ('.patch-test-' + [Guid]::NewGuid().ToString('N'))
$git = (Get-Command git -ErrorAction Stop).Source
$encoding = [Text.UTF8Encoding]::new($false)
New-Item -ItemType Directory -Force -Path $fixture | Out-Null
try {
    $manifestFixture = Join-Path $fixture 'manifest-validation'
    New-Item -ItemType Directory -Path $manifestFixture | Out-Null
    [IO.File]::WriteAllText((Join-Path $manifestFixture 'a.patch'), '', $encoding)
    $manifestPath = Join-Path $manifestFixture 'series.json'
    foreach ($invalid in @(
        '{"version":2,"patches":["a.patch"]}',
        '{"version":1,"patches":"a.patch"}',
        '{"version":1,"patches":["a.patch","a.patch"]}',
        '{"version":1,"patches":["missing.patch"]}',
        '{"version":1,"patches":["../a.patch"]}'
    )) {
        [IO.File]::WriteAllText($manifestPath, $invalid, $encoding)
        $rejected = $false
        try { Get-SourcePatchNames $manifestFixture | Out-Null } catch { $rejected = $true }
        if (!$rejected) { throw "Invalid manifest accepted: $invalid" }
    }
    [IO.File]::WriteAllText($manifestPath, '{"version":1,"patches":["a.patch"]}', $encoding)
    if (@(Get-SourcePatchNames $manifestFixture).Count -ne 1) { throw 'Valid manifest rejected' }
    [IO.File]::WriteAllText((Join-Path $manifestFixture 'unregistered.patch'), '', $encoding)
    $rejected = $false
    try { Get-SourcePatchNames $manifestFixture | Out-Null } catch { $rejected = $true }
    if (!$rejected) { throw 'Unregistered patch accepted' }
    Remove-Managed $manifestFixture $fixture
    Invoke-Checked $git @('init', '--quiet', $fixture)
    foreach ($name in $patchNames) {
        foreach ($line in [IO.File]::ReadAllLines((Join-Path $ProjectRoot "resources\patches\$name"))) {
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
    if (Update-LegacySidebarCloseTabsPatch $fixture) { throw 'Pristine sidebar was upgraded' }
    if ((Get-AppliedSourcePatches $fixture $patchNames).Count -ne 0) { throw 'Pristine sources were marked patched' }
    foreach ($name in $patchNames[0..7]) { Invoke-Checked $git @('-C', $fixture, 'apply', (Join-Path $ProjectRoot "resources\patches\$name")) }
    if ((Get-AppliedSourcePatches $fixture $patchNames).Count -ne 8) { throw 'Partial patch stack not recognized' }
    foreach ($name in $patchNames[8..($patchNames.Count - 1)]) { Invoke-Checked $git @('-C', $fixture, 'apply', (Join-Path $ProjectRoot "resources\patches\$name")) }
    if ((Get-AppliedSourcePatches $fixture $patchNames).Count -ne $patchNames.Count) { throw 'Overlapping patch stack not recognized' }
    # The previous install fix must remain recognizable while adding cache checks.
    $installCachePatch = Join-Path $ProjectRoot 'resources/patches/source-install-cache.patch'
    $installIntegrityPatch = Join-Path $ProjectRoot 'resources/patches/source-install-integrity.patch'
    $installRuntimePatch = Join-Path $ProjectRoot 'resources/patches/source-install-runtime.patch'
    Invoke-Checked $git @('-C', $fixture, 'apply', '--reverse', $installRuntimePatch)
    Invoke-Checked $git @('-C', $fixture, 'apply', '--reverse', $installIntegrityPatch)
    Invoke-Checked $git @('-C', $fixture, 'apply', '--reverse', $installCachePatch)
    $previousInstall = Get-AppliedSourcePatches $fixture $patchNames
    if ($previousInstall.Count -ne ($patchNames.Count - 3) -or !$previousInstall.Contains('source-postinstall.patch')) { throw 'Previous install fix upgrade not recognized' }
    Invoke-Checked $git @('-C', $fixture, 'apply', $installCachePatch)
    Invoke-Checked $git @('-C', $fixture, 'apply', $installIntegrityPatch)
    Invoke-Checked $git @('-C', $fixture, 'apply', $installRuntimePatch)
    # Historical close-tab upgrades predate the empty-sidebar behavior.
    Invoke-Checked $git @('-C', $fixture, 'apply', '--reverse', (Join-Path $ProjectRoot 'resources\patches\sidebar-auto-close.patch'))
    $previousPatchNames = @($patchNames | Where-Object { $_ -ne 'sidebar-auto-close.patch' })
    if ((Get-AppliedSourcePatches $fixture $patchNames).Count -ne $previousPatchNames.Count) { throw 'Previous sidebar stack not recognized' }
    Invoke-Checked $git @('-C', $fixture, 'apply', '--reverse', (Join-Path $ProjectRoot 'resources\patches\sidebar-empty.patch'))
    $legacyTabPatchNames = @($previousPatchNames | Where-Object { $_ -ne 'sidebar-empty.patch' })
    # A historical sidebar hunk blocks recognition of earlier panel patches.
    $tabs = Join-Path $fixture 'src/vs/workbench/browser/parts/compositeBarActions.ts'
    $tabCurrent = [IO.File]::ReadAllText($tabs) + "`n// unrelated sidebar customization`n"
    $tabLegacy = $tabCurrent.Replace('if (!event.repeat) { closeTab(); }', 'closeTab();')
    [IO.File]::WriteAllText($tabs, $tabLegacy, $encoding)
    if ((Get-AppliedSourcePatches $fixture $legacyTabPatchNames).Contains('terminal-panel.patch')) { throw 'Legacy failure fixture did not reproduce panel misdetection' }
    if (-not (Update-LegacySidebarCloseTabsPatch $fixture)) { throw 'Legacy sidebar was not upgraded' }
    if ([IO.File]::ReadAllText($tabs) -cne $tabCurrent) { throw 'Sidebar upgrade lost unrelated edits' }
    if ((Get-AppliedSourcePatches $fixture $legacyTabPatchNames).Count -ne $legacyTabPatchNames.Count) { throw 'Sidebar upgrade did not restore stack detection' }
    if (Update-LegacySidebarCloseTabsPatch $fixture) { throw 'Current sidebar upgraded twice' }
    $tabConflict = $tabLegacy.Replace("close.className = 'ubovm-sidebar-tab-close';", "close.className = 'custom-tab-close';")
    [IO.File]::WriteAllText($tabs, $tabConflict, $encoding)
    if (Update-LegacySidebarCloseTabsPatch $fixture) { throw 'Unknown sidebar conflict overwritten' }
    if ([IO.File]::ReadAllText($tabs) -cne $tabConflict) { throw 'Sidebar conflict check mutated source' }
    [IO.File]::WriteAllText($tabs, $tabCurrent, $encoding)
    # Simulate the installed Worker patch before sidebar tabs were introduced.
    # Older builds must keep both terminal and Worker hunks recognized.
    $sidebarPatch = Join-Path $ProjectRoot 'resources\patches\worker-sidebar-tabs.patch'
    Invoke-Checked $git @('-C', $fixture, 'apply', '--reverse', (Join-Path $ProjectRoot 'resources\patches\sidebar-close-tabs.patch'))
    Invoke-Checked $git @('-C', $fixture, 'apply', '--reverse', $sidebarPatch)
    $legacyWorker = Get-AppliedSourcePatches $fixture $patchNames
    if (-not $legacyWorker.Contains('terminal-panel.patch') -or -not $legacyWorker.Contains('worker-panel.patch') -or $legacyWorker.Contains('worker-sidebar-tabs.patch')) { throw 'Legacy Worker stack not recognized' }
    foreach ($name in $patchNames) {
        if (-not $legacyWorker.Contains($name)) { Invoke-Checked $git @('-C', $fixture, 'apply', (Join-Path $ProjectRoot "resources\patches\$name")) }
    }
    if ((Get-AppliedSourcePatches $fixture $patchNames).Count -ne $patchNames.Count) { throw 'Worker sidebar upgrade not repeatable' }
    # Historical menu upgrades predate the Markdown command-policy override.
    # Peel that later layer before constructing the historical fixture.
    Invoke-Checked $git @('-C', $fixture, 'apply', '--reverse', (Join-Path $ProjectRoot 'resources/patches/file-search.patch'))
    $patchNames = @($patchNames | Where-Object { $_ -ne 'file-search.patch' })
    Invoke-Checked $git @('-C', $fixture, 'apply', '--reverse', (Join-Path $ProjectRoot 'resources/patches/markdown-preview.patch'))
    $patchNames = @($patchNames | Where-Object { $_ -ne 'markdown-preview.patch' })
    $actions = Join-Path $fixture 'src\vs\platform\actions\common\actions.ts'
    $custom = [IO.File]::ReadAllText($actions) + "`n// user change outside patch hunks`n"
    [IO.File]::WriteAllText($actions, $custom, $encoding)
    if ((Get-AppliedSourcePatches $fixture $patchNames).Count -ne $patchNames.Count) { throw 'Unrelated edits prevented patch detection' }
    if ([IO.File]::ReadAllText($actions) -cne $custom) { throw 'Detection mutated source' }
    $commands = "'ubovm.validateCodeChanges', 'ubovm.attachSelection', 'ubovm.reviewCodeChanges', "
    [IO.File]::WriteAllText($actions, $custom.Replace($commands, ''), $encoding)
    $minimal = Join-Path $ProjectRoot 'resources\patches\minimal-ui.patch'
    if (-not (Update-LegacyMinimalUiPatch $fixture $minimal)) { throw 'Known legacy patch not upgraded' }
    if ([IO.File]::ReadAllText($actions) -cne $custom) { throw 'Upgrade failed to preserve unrelated edits' }
    if (Update-LegacyMinimalUiPatch $fixture $minimal) { throw 'Current patch was upgraded twice' }
    $editorCommands = "'ubovm.expandFileEditor', 'ubovm.restoreFileEditor', "
    foreach ($missing in @($editorCommands, ($editorCommands + $commands))) {
        [IO.File]::WriteAllText($actions, $custom.Replace($missing, ''), $encoding)
        if (-not (Update-LegacyMinimalUiPatch $fixture $minimal)) { throw 'Legacy file-editor menu policy not upgraded' }
        if ([IO.File]::ReadAllText($actions) -cne $custom) { throw 'Editor menu upgrade lost unrelated changes' }
    }
    $conflict = $custom.Replace($commands, '').Replace("'ubovm.toggleTheme',", "'user.customCommand',")
    [IO.File]::WriteAllText($actions, $conflict, $encoding)
    if (Update-LegacyMinimalUiPatch $fixture $minimal) { throw 'Unknown conflict was silently overwritten' }
    if ([IO.File]::ReadAllText($actions) -cne $conflict) { throw 'Conflict check changed source' }
    $modePatch = Join-Path $ProjectRoot 'resources/patches/sidebar-mode.patch'
    $legacyMode = Join-Path $ProjectRoot 'resources/patches/legacy/sidebar-mode-v1.patch'
    $tree = Join-Path $fixture 'src/vs/workbench/browser/parts/views/treeView.ts'
    # Peel the DOM Event type fix before simulating the older sidebar layer.
    $eventPatch = Join-Path $ProjectRoot 'resources/patches/sidebar-event-type.patch'
    Invoke-Checked $git @('-C', $fixture, 'apply', '--reverse', $eventPatch)
    Invoke-Checked $git @('-C', $fixture, 'apply', '--reverse', $modePatch)
    Invoke-Checked $git @('-C', $fixture, 'apply', $legacyMode)
    $oldTree = [IO.File]::ReadAllText($tree) + "`n// unrelated tree customization`n"
    [IO.File]::WriteAllText($tree, $oldTree, $encoding)
    if (-not (Update-LegacySidebarModePatch $fixture)) { throw 'Legacy loading sidebar was not upgraded' }
    if (-not [IO.File]::ReadAllText($tree).Replace("`r`n", "`n").EndsWith("// unrelated tree customization`n")) { throw 'Tree customization was lost' }
    if (Update-LegacySidebarModePatch $fixture) { throw 'Current loading sidebar upgraded twice' }
    Invoke-Checked $git @('-C', $fixture, 'apply', '--reverse', '--check', $modePatch)
    Invoke-Checked $git @('-C', $fixture, 'apply', $eventPatch)
    Invoke-Checked $git @('-C', $fixture, 'apply', '--reverse', '--check', $eventPatch)
    $conflictedTree = $oldTree.Replace("loading.className = 'ubovm-session-loading';", "loading.className = 'custom-loading';")
    [IO.File]::WriteAllText($tree, $conflictedTree, $encoding)
    if (Update-LegacySidebarModePatch $fixture) { throw 'Unknown loading sidebar conflict overwritten' }
    if ([IO.File]::ReadAllText($tree) -cne $conflictedTree) { throw 'Loading sidebar conflict check changed source' }
    Write-Host '[OK] Pristine, partial, overlapping, legacy, repeat, and conflict cases passed; local edits preserved.'
} finally { Remove-Managed $fixture $cache }
