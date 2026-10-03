$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $ProjectRoot 'build.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Invoke-Core', 'Assert-ChildPath', 'Remove-Managed')) {
    $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    . ([scriptblock]::Create($definition.Extent.Text))
}
$repository = $ProjectRoot
$fixture = Join-Path $ProjectRoot ('.cache/source-lock-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path (Join-Path $fixture '.cache') | Out-Null
$child = $null
try {
    $ProjectRoot = $fixture
    $script:calls = [Collections.Generic.List[string]]::new()
    $script:failApply = $false
    function Invoke-CoreUnlocked($Action) {
        $script:calls.Add($Action)
        if ($Action -eq 'build') { Invoke-Core ensure-install }
        if ($Action -eq 'ensure-install') { Invoke-Core install }
        if ($Action -eq 'install') { Invoke-Core apply }
        if ($Action -eq 'apply' -and $script:failApply) { throw 'simulated installation failure' }
    }
    Invoke-Core ensure-install
    if (($script:calls -join ',') -ne 'ensure-install,install,apply' -or $script:SourceMutationLock) { throw 'Nested source operation did not release its lock' }
    $script:calls.Clear()
    Invoke-Core build
    if (($script:calls -join ',') -ne 'build,ensure-install,install,apply' -or $script:SourceMutationLock) { throw 'Build did not preserve the source lock through dependency preparation' }
    $script:failApply = $true
    $rejected = $false
    try { Invoke-Core install } catch { $rejected = $_.Exception.Message -match 'simulated installation failure' }
    if (!$rejected -or $script:SourceMutationLock) { throw 'Failed install leaked its lock' }
    $script:failApply = $false
    Invoke-Core install
    # Execute the actual ensure-install branch to verify its second cache check.
    $coreDefinition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-CoreUnlocked' }, $true)
    $coreSwitch = $coreDefinition.Find({ param($node) $node -is [Management.Automation.Language.SwitchStatementAst] -and $node.Condition.Extent.Text -eq '$Action' }, $true)
    $ensureClause = $coreSwitch.Clauses | Where-Object { $_.Item1.Extent.Text -eq "'ensure-install'" }
    $ensureText = $ensureClause.Item2.Extent.Text
    $ensure = [scriptblock]::Create($ensureText.Substring(1, $ensureText.Length - 2))
    function Test-SourceInstallState($SourceRoot) { return $script:stateCurrent }
    $script:stateCurrent = $false
    $script:calls.Clear()
    & $ensure
    if (($script:calls -join ',') -ne 'install,apply') { throw 'Incomplete state did not request installation' }
    $script:stateCurrent = $true
    $script:calls.Clear()
    & $ensure
    if ($script:calls.Count) { throw 'A completed competing installation was redundantly repeated' }
    # Hold the same lock in another process, then terminate that process.
    $lockPath = Join-Path $fixture '.cache/source-mutation.lock'
    $holder = Join-Path $fixture 'holder.ps1'
    [IO.File]::WriteAllText($holder, 'param($LockPath); $handle = [IO.File]::Open($LockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); [Console]::WriteLine("ready"); Start-Sleep -Seconds 30')
    $info = [Diagnostics.ProcessStartInfo]::new((Get-Process -Id $PID).Path)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "{0}" "{1}"' -f $holder, $lockPath
    $child = [Diagnostics.Process]::Start($info)
    $ready = $child.StandardOutput.ReadLineAsync()
    if (!$ready.Wait(10000) -or $ready.Result -ne 'ready') { throw 'Lock holder failed to start' }
    $before = $script:calls.Count
    $rejected = $false
    try { Invoke-Core install } catch { $rejected = $_.Exception.Message -match 'source operation lock' }
    if (!$rejected -or $script:calls.Count -ne $before) { throw 'Concurrent install was allowed to mutate source' }
    $child.Kill(); $child.WaitForExit()
    Invoke-Core install
    if ($script:SourceMutationLock) { throw 'Reacquired lock leaked after crashed holder' }
    Write-Host '[OK] Nested install, failure cleanup, cross-process exclusion, and recovery after terminated process'
} finally {
    if ($child) { if (!$child.HasExited) { $child.Kill(); $child.WaitForExit() }; $child.Dispose() }
    $ProjectRoot = $repository
    Remove-Managed $fixture (Join-Path $repository '.cache')
}
