$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $ProjectRoot 'build.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
foreach ($name in @('Assert-ChildPath', 'Remove-Managed', 'Invoke-InstallerCompiler')) {
    $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    . ([scriptblock]::Create($definition.Extent.Text))
}
$fixture = Join-Path $ProjectRoot ('.cache/installer-compiler-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$savedTemp = $env:TEMP; $savedTmp = $env:TMP
function Start-Sleep { param($Seconds) }
try {
    $probe = Join-Path $fixture 'compiler.cjs'
    [IO.File]::WriteAllText($probe, @'
const fs = require('node:fs'), path = require('node:path');
const mode = process.argv[2], temp = process.env.TEMP;
if (temp !== process.env.TMP || !fs.statSync(temp).isDirectory()) process.exit(9);
fs.writeFileSync(path.join(temp, 'probe'), 'ok');
console.log('Temp: ' + temp);
if (mode === 'recover' && path.basename(temp) === 'temp-2') process.exit(0);
console.error(mode === 'syntax' ? 'Unknown directive' : 'Resource update error: EndUpdateResource failed (110)');
process.exit(2);
'@)
    foreach ($mode in @('recover', 'syntax', 'persistent')) {
        $stage = Join-Path $fixture $mode
        New-Item -ItemType Directory -Path $stage | Out-Null
        $failure = $null
        try { Invoke-InstallerCompiler (Get-Command node.exe).Source @($probe, $mode) $stage } catch { $failure = $_ }
        if (($mode -eq 'recover') -ne ($null -eq $failure)) { throw "Unexpected result for ${mode}: $failure" }
        $expected = switch ($mode) { 'recover' { 2 }; 'syntax' { 1 }; 'persistent' { 3 } }
        $logs = @(Get-ChildItem -LiteralPath $stage -Recurse -Filter 'iscc-*.log')
        if ($logs.Count -ne $expected) { throw "Incorrect retry count for $mode" }
        if ($failure -and $failure.ToString() -notmatch 'Diagnostics:') { throw 'Missing failure log path' }
        if ($env:TEMP -ne $savedTemp -or $env:TMP -ne $savedTmp -or $ErrorActionPreference -ne 'Stop') { throw 'Compiler environment was not restored' }
    }
    Write-Host '[OK] Resource-error recovery, bounded retries, non-resource fail-fast, logs and environment restoration'
} finally {
    $env:TEMP = $savedTemp; $env:TMP = $savedTmp
    Remove-Managed $fixture (Join-Path $ProjectRoot '.cache')
}
