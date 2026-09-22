$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $ProjectRoot 'build.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Assert-ChildPath', 'Remove-Managed', 'Start-SourceDesktop')) {
    $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    . ([scriptblock]::Create($definition.Extent.Text))
}
$fixture = Join-Path $ProjectRoot ('.cache/platform-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $fixture | Out-Null
$repository = $ProjectRoot
try {
    Assert-ChildPath (Join-Path $fixture 'child') $fixture
    foreach ($target in @($fixture, ($fixture + '-sibling'), (Join-Path $fixture '../escape'))) {
        $rejected = $false
        try { Assert-ChildPath $target $fixture } catch { $rejected = $true }
        if (-not $rejected) { throw "Unsafe managed path accepted: $target" }
    }
    $ProjectRoot = $fixture
    $script:actions = [Collections.Generic.List[string]]::new()
    function Invoke-Core($Action) {
        $script:actions.Add($Action)
        if ($Action -eq 'start' -and $env:UBOVM_SOURCE_SMOKE -eq '1') {
            if (-not (Test-Path -LiteralPath $env:UBOVM_SMOKE_WORKSPACE)) { throw 'Missing smoke workspace' }
            [IO.File]::WriteAllText($env:UBOVM_SMOKE_RESULT, '{"ok":true}')
        }
    }
    $env:UBOVM_ARGUMENT = $fixture
    Start-SourceDesktop
    if (($script:actions -join ',') -ne 'install,build,start') { throw 'First source start did not prepare the core' }
    $compiled = Join-Path $fixture 'vendor/vscode/out/vs/workbench'
    New-Item -ItemType Directory -Force -Path $compiled | Out-Null
    [IO.File]::WriteAllText((Join-Path $compiled 'workbench.desktop.main.js'), '')
    $script:actions.Clear()
    Start-SourceDesktop -Smoke
    if (($script:actions -join ',') -ne 'start') { throw 'Cached source start rebuilt the core' }
    function Invoke-Core($Action) { }
    $rejected = $false
    try { Start-SourceDesktop -Smoke } catch { $rejected = $true }
    if (-not $rejected) { throw 'Missing smoke report was accepted or stale report reused' }
    Write-Host '[OK] Source startup, isolated smoke reports, and managed path boundaries'
} finally {
    $ProjectRoot = $repository
    Remove-Managed $fixture (Join-Path $repository '.cache')
}
