$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$tokens = $null; $errors = $null
# ParseFile uses the same encoding rules as Windows PowerShell -File.
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $ProjectRoot 'build.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Assert-ChildPath', 'Remove-Managed', 'Replace-CoreSnippet', 'Get-PatchAdditions', 'Set-CoreChecksum', 'Get-WorkbenchStyle', 'Set-StartupHtml', 'Set-FixedConversationCore')) {
    $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    . ([scriptblock]::Create($definition.Extent.Text))
}
$fixture = Join-Path $ProjectRoot ('.cache/prebuilt-patches-' + [Guid]::NewGuid().ToString('N'))
$AppRoot = $fixture
$config = Get-Content (Join-Path $ProjectRoot 'resources/app.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$archivePath = Join-Path $ProjectRoot ('.cache/' + ($config.core.runtime.url -split '/')[-1])
if (-not (Test-Path -LiteralPath $archivePath)) { throw 'Run node build.mjs setup to cache the pinned runtime first.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
$files = @('out/vs/workbench/workbench.desktop.main.js', 'out/vs/workbench/workbench.desktop.main.css', 'out/vs/code/electron-browser/workbench/workbench.html')
try {
    foreach ($file in $files) {
        $destination = Join-Path $fixture $file
        New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
        $entry = $archive.GetEntry('resources/app/' + $file)
        if (-not $entry) { throw "Missing archive entry: $file" }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination)
    }
    $product = [pscustomobject]@{ checksums = [pscustomobject]@{} }
    Set-FixedConversationCore $product
    $first = @($files | ForEach-Object { (Get-FileHash (Join-Path $fixture $_)).Hash })
    $bundle = [IO.File]::ReadAllText((Join-Path $fixture $files[0]))
    $expectedLabel = [string][char]0x6587 + [char]0x4EF6
    if (-not $bundle.Contains('?.name??"' + $expectedLabel + '"')) { throw 'PowerShell decoded the Chinese patch text incorrectly.' }
    Set-FixedConversationCore $product
    $second = @($files | ForEach-Object { (Get-FileHash (Join-Path $fixture $_)).Hash })
    for ($index = 0; $index -lt $files.Count; $index++) {
        if ($first[$index] -ne $second[$index]) { throw "Repeated patching changed $($files[$index])." }
    }
    Write-Host '[OK] Pristine runtime patches, Unicode labels, and repeated patching'
} finally {
    $archive.Dispose()
    if (Test-Path -LiteralPath $fixture) { Remove-Managed $fixture (Join-Path $ProjectRoot '.cache') }
}
