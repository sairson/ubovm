# Shared Windows PowerShell 5.1 / PowerShell 7 build logic.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$ProjectRoot = $PSScriptRoot
$OnWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
$OnMac = -not $OnWindows -and $IsMacOS
$NpmCommand = if ($OnWindows) { 'npm.cmd' } else { 'npm' }
$NodeCommand = if ($OnWindows) { 'node.exe' } else { 'node' }
$UsePrebuilt = $OnWindows -and [Environment]::Is64BitOperatingSystem -and $env:PROCESSOR_ARCHITECTURE -ne 'ARM64' -and $env:PROCESSOR_ARCHITEW6432 -ne 'ARM64'
$Config = Get-Content -LiteralPath (Join-Path $ProjectRoot 'resources/app.json') -Raw | ConvertFrom-Json
$Action = if ($env:UBOVM_ACTION) { $env:UBOVM_ACTION } else { 'start' }
$RuntimeRoot = Join-Path $ProjectRoot '.runtime'
$Runtime = [IO.Path]::GetFullPath((Join-Path $ProjectRoot $Config.core.runtime.directory))
$AppRoot = Join-Path $Runtime 'resources/app'
$Executable = Join-Path $Runtime $Config.core.runtime.executable

function Write-Json($Path, $Value) {
    $text = ($Value | ConvertTo-Json -Depth 50) + [Environment]::NewLine
    [IO.File]::WriteAllText($Path, $text, [Text.UTF8Encoding]::new($false))
}

function Assert-ChildPath($Path, $Parent) {
    $full = [IO.Path]::GetFullPath($Path)
    $prefix = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $comparison = if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    if (-not $full.StartsWith($prefix, $comparison)) {
        throw "Path must stay inside ${Parent}: $Path"
    }
}

function Remove-Managed($Path, $Parent) {
    Assert-ChildPath $Parent $ProjectRoot
    Assert-ChildPath $Path $Parent
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force }
}

function Invoke-Checked($File, $Arguments, $WorkingDirectory = $ProjectRoot, $TimeoutMilliseconds = 0) {
    Push-Location -LiteralPath $WorkingDirectory
    try {
        if ($TimeoutMilliseconds -gt 0) {
            $info = [Diagnostics.ProcessStartInfo]::new($File)
            $info.UseShellExecute = $false
            $info.WorkingDirectory = $WorkingDirectory
            foreach ($argument in $Arguments) { [void]$info.ArgumentList.Add([string]$argument) }
            $child = [Diagnostics.Process]::Start($info)
            try {
                if (-not $child.WaitForExit($TimeoutMilliseconds)) {
                    $child.Kill($true)
                    $child.WaitForExit()
                    throw 'Source desktop integration test timed out.'
                }
                if ($child.ExitCode -ne 0) { throw "$File exited with $($child.ExitCode)" }
            } finally { $child.Dispose() }
            return
        }
        & $File @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$File exited with $LASTEXITCODE" }
    } finally { Pop-Location }
}

function Assert-Archive($Path) {
    $stream = [IO.File]::OpenRead($Path)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $hasher.Dispose() }
    if ($actual -ne $Config.core.runtime.sha256) {
        throw "SHA-256 mismatch. Remove this archive and retry: $Path"
    }
}

function Get-FileDigest($Path) {
    $stream = [IO.File]::OpenRead($Path)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $hasher.Dispose() }
}

function Get-RuntimeDownloadUrls {
    $urls = [System.Collections.Generic.List[string]]::new()
    if ($env:UBOVM_RUNTIME_URL) { [void]$urls.Add([string]$env:UBOVM_RUNTIME_URL) }
    # Prefer configured mirrors first: GitHub release assets often stall behind
    # Great Firewall / corporate proxies, while mirrors stay resumable via curl.
    if ($Config.core.runtime.PSObject.Properties.Name -contains 'mirrorUrls' -and $Config.core.runtime.mirrorUrls) {
        foreach ($mirror in @($Config.core.runtime.mirrorUrls)) {
            if ($mirror) { [void]$urls.Add([string]$mirror) }
        }
    }
    $primary = [string]$Config.core.runtime.url
    if ($primary -match '^https://github\.com/') {
        [void]$urls.Add('https://ghproxy.net/' + $primary)
    }
    [void]$urls.Add($primary)
    $seen = @{}
    $ordered = @()
    foreach ($url in $urls) {
        if (-not $seen.ContainsKey($url)) { $seen[$url] = $true; $ordered += $url }
    }
    return $ordered
}

function Invoke-ArchiveDownload($Urls, $Destination, $ExpectedSha256) {
    Assert-ChildPath $Destination (Split-Path $Destination -Parent)
    $partial = $Destination + '.partial'
    $sourceMarker = $partial + '.source'
    $failures = [System.Collections.Generic.List[string]]::new()
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    foreach ($url in $Urls) {
        Write-Host "[UBOVM] Downloading archive: $url"
        if ((Test-Path -LiteralPath $sourceMarker) -and (Get-Content -LiteralPath $sourceMarker -Raw).Trim() -ne $url) {
            if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
        }
        [IO.File]::WriteAllText($sourceMarker, ($url + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
        try {
            if ($curl) {
                Invoke-Checked $curl.Source @(
                    '-fL', '--connect-timeout', '30', '--max-time', '0',
                    '--retry', '8', '--retry-delay', '5', '--retry-all-errors',
                    '-C', '-', '-o', $partial, $url
                )
            } else {
                Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $partial
            }
            if ((Get-FileDigest $partial) -ne $ExpectedSha256) {
                throw 'Downloaded archive SHA-256 does not match resources/app.json.'
            }
            Move-Item -LiteralPath $partial -Destination $Destination -Force
            if (Test-Path -LiteralPath $sourceMarker) { Remove-Item -LiteralPath $sourceMarker -Force }
            return
        } catch {
            [void]$failures.Add("$url :: $($_.Exception.Message)")
            Write-Host ("[UBOVM] Download failed: " + $_.Exception.Message) -ForegroundColor Yellow
        }
    }
    throw ("All runtime download URLs failed.`n" + ($failures -join "`n"))
}

function Get-HarnessInstaller {
    $node = Get-Command $NodeCommand -ErrorAction SilentlyContinue
    $npm = Get-Command $NpmCommand -ErrorAction SilentlyContinue
    if ($node -and $npm) {
        $version = [version]((& $node.Source --version).Trim() -replace '^v', '')
        if ($version.Major -eq 24 -and $version -ge [version]'24.18.0') {
            return @{ Node = $node.Source; Npm = $npm.Source }
        }
    }
    if (-not $UsePrebuilt) { throw 'Install Node.js >=24.18.0 <25 with npm on PATH.' }
    # The desktop remains usable without a system Node installation. This
    # private installer is only needed on the first dependency preparation.
    $version = '24.18.0'
    $archiveName = "node-v$version-win-x64.zip"
    $digest = '0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821'
    $cache = Join-Path $ProjectRoot '.cache'
    $managed = Join-Path $cache "node-v$version-win-x64"
    $managedNode = Join-Path $managed 'node.exe'
    $managedNpm = Join-Path $managed 'npm.cmd'
    New-Item -ItemType Directory -Force -Path $cache | Out-Null
    if (-not (Test-Path -LiteralPath $managedNode) -or -not (Test-Path -LiteralPath $managedNpm)) {
        $archive = Join-Path $cache $archiveName
        if (-not (Test-Path -LiteralPath $archive)) {
            Write-Host '[UBOVM] Preparing a private Node installer for the agent SDK...'
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            $partial = $archive + '.partial'
            Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$version/$archiveName" -OutFile $partial
            if ((Get-FileDigest $partial) -ne $digest) { throw "Node archive SHA-256 mismatch: $partial" }
            Move-Item -LiteralPath $partial -Destination $archive -Force
        }
        if ((Get-FileDigest $archive) -ne $digest) { throw "Node archive SHA-256 mismatch: $archive" }
        $staging = Join-Path $cache ('.node-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $staging | Out-Null
        try {
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            [IO.Compression.ZipFile]::ExtractToDirectory($archive, $staging)
            Remove-Managed $managed $cache
            $extracted = Join-Path $staging "node-v$version-win-x64"
            Assert-ChildPath $extracted $staging
            Assert-ChildPath $managed $cache
            Move-Item -LiteralPath $extracted -Destination $managed
        } finally { Remove-Managed $staging $cache }
    }
    return @{ Node = $managedNode; Npm = $managedNpm }
}

function Sync-Harness($Destination) {
    Assert-ChildPath $Destination $ProjectRoot
    $source = Join-Path $ProjectRoot 'src/harness'
    if (-not (Test-Path -LiteralPath (Join-Path $source 'index.mjs'))) { throw 'Missing agent SDK: src/harness/index.mjs' }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $lockPath = Join-Path $ProjectRoot 'package-lock.json'
    $lockDigest = Get-FileDigest $lockPath
    $manifest = Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json
    $stamp = Join-Path $Destination '.harness-dependencies.json'
    $installer = Get-HarnessInstaller
    $installerNode = $installer.Node
    $hostArch = (& $installerNode -p process.arch).Trim()
    $hostPlatform = (& $installerNode -p process.platform).Trim()
    $installed = if (Test-Path -LiteralPath $stamp) { Get-Content -LiteralPath $stamp -Raw | ConvertFrom-Json } else { $null }
    $dependencyFiles = @($manifest.dependencies.PSObject.Properties | ForEach-Object { Join-Path $Destination ('node_modules/' + $_.Name + '/package.json') })
    $missing = @($dependencyFiles | Where-Object { -not (Test-Path -LiteralPath $_) })
    if (-not $installed -or $installed.lockDigest -ne $lockDigest -or $installed.schemaVersion -ne 2 -or $installed.platform -ne $hostPlatform -or $installed.arch -ne $hostArch -or $missing.Count) {
        $installer = Get-HarnessInstaller
        $staging = Join-Path $Destination ('.dependencies-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $staging | Out-Null
        $oldPath = $env:PATH
        try {
            $runtimeManifest = [ordered]@{
                name = $manifest.name; version = $manifest.version; private = $true; type = 'module'
                engines = $manifest.engines; dependencies = $manifest.dependencies
                exports = @{ '.' = './harness/index.mjs'; './harness' = './harness/index.mjs' }
            }
            Write-Json (Join-Path $staging 'package.json') $runtimeManifest
            Copy-Item -LiteralPath $lockPath -Destination (Join-Path $staging 'package-lock.json')
            $env:PATH = (Split-Path -Parent $installer.Node) + [IO.Path]::PathSeparator + $oldPath
            Write-Host '[UBOVM] Installing the pinned agent SDK production dependencies...'
            Invoke-Checked $installer.Npm @('ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', (Join-Path $ProjectRoot '.cache/npm')) $staging
            $modules = Join-Path $Destination 'node_modules'
            Remove-Managed $modules $Destination
            $stagedModules = Join-Path $staging 'node_modules'
            Assert-ChildPath $stagedModules $staging
            Assert-ChildPath $modules $Destination
            Move-Item -LiteralPath $stagedModules -Destination $modules
            Copy-Item -LiteralPath (Join-Path $staging 'package.json') -Destination (Join-Path $Destination 'package.json') -Force
            Copy-Item -LiteralPath $lockPath -Destination (Join-Path $Destination 'package-lock.json') -Force
            Write-Json $stamp @{ schemaVersion = 2; lockDigest = $lockDigest; platform = $hostPlatform; arch = $hostArch }
        } finally {
            $env:PATH = $oldPath
            Remove-Managed $staging $Destination
        }
    }
    # Include relative paths in the digest: file additions, removals and renames
    # all invalidate the SDK copy. Dependencies remain cached independently.
    $fingerprint = (@(Get-ChildItem -LiteralPath $source -Recurse -File | Sort-Object FullName | ForEach-Object {
        $_.FullName.Substring($source.Length) + ':' + (Get-FileDigest $_.FullName)
    }) -join "`n")
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $sourceDigest = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($fingerprint))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
    $sourceStamp = Join-Path $Destination '.harness-source.json'
    $previous = if (Test-Path -LiteralPath $sourceStamp) { Get-Content -LiteralPath $sourceStamp -Raw | ConvertFrom-Json } else { $null }
    $target = Join-Path $Destination 'harness'
    if (-not $previous -or $previous.digest -ne $sourceDigest -or -not (Test-Path -LiteralPath (Join-Path $target 'index.mjs'))) {
        $stage = Join-Path $Destination ('.harness-' + [Guid]::NewGuid().ToString('N'))
        try {
            Copy-Item -LiteralPath $source -Destination $stage -Recurse
            Remove-Managed $target $Destination
            Assert-ChildPath $stage $Destination
            Assert-ChildPath $target $Destination
            Move-Item -LiteralPath $stage -Destination $target
            Write-Json $sourceStamp @{ digest = $sourceDigest }
        } finally { Remove-Managed $stage $Destination }
    }
    Invoke-Checked $installer.Node @((Join-Path $ProjectRoot 'src/main/prepare-python.mjs'), (Join-Path $Destination 'runtime/python'))
    Write-Host '[OK] Agent SDK, bundled Python and production dependencies prepared'
}

function Set-PortableData($Name) {
    # The launcher and a directly opened executable share the same migration
    # and home-directory policy. Never create an empty target before migration.
    $installer = Get-HarnessInstaller
    $prepared = & $installer.Node (Join-Path $ProjectRoot 'src/main/prepare-data.mjs') --profile $Name --legacy-root $ProjectRoot
    if ($LASTEXITCODE -ne 0) { throw 'Unable to prepare ~/.ubovm data. Existing data was left untouched.' }
    $paths = ($prepared -join "`n") | ConvertFrom-Json
    $portable = $paths.portable
    New-Item -ItemType Directory -Force -Path (Join-Path $paths.userData 'User') | Out-Null
    $settings = Join-Path $portable 'user-data/User/settings.json'
    # Preserve all existing user settings, including JSONC and user edits.
    if (-not (Test-Path -LiteralPath $settings)) { Write-Json $settings $Config.settings }
    # A BAT launched from PowerShell 7 may inherit both Path and PATH. Windows
    # PowerShell 5's Env: provider throws while enumerating that environment.
    # Normalize names through .NET before either Env: or ProcessStartInfo needs
    # a case-insensitive dictionary; preserve the value selected by Windows.
    $environment = [Environment]::GetEnvironmentVariables('Process')
    if ($OnWindows) { foreach ($duplicates in @($environment.Keys | Group-Object { $_.ToUpperInvariant() } | Where-Object { $_.Count -gt 1 })) {
        $canonical = [string]$duplicates.Group[0]
        $value = [Environment]::GetEnvironmentVariable($canonical, 'Process')
        foreach ($variable in $duplicates.Group) { [Environment]::SetEnvironmentVariable([string]$variable, $null, 'Process') }
        [Environment]::SetEnvironmentVariable($canonical, $value, 'Process')
    }
    }
    foreach ($launchEnvironmentName in @([Environment]::GetEnvironmentVariables('Process').Keys | Where-Object { $_ -like 'VSCODE_*' -or $_ -in @('ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_NO_ASAR') })) {
        [Environment]::SetEnvironmentVariable([string]$launchEnvironmentName, $null, 'Process')
    }
    $env:VSCODE_PORTABLE = $portable
    $env:UBOVM_DATA_PROFILE = $Name
    $env:VSCODE_EXTENSIONS = $paths.extensions
    $env:TEMP = Join-Path $portable 'tmp'
    $env:TMP = $env:TEMP
    $env:TMPDIR = $env:TEMP
    return $portable
}

function Replace-CoreSnippet([string]$Text, [string]$Before, [string]$After) {
    if ($Text.Contains($After)) { return $Text }
    $matches = [regex]::Matches($Text, [regex]::Escape($Before)).Count
    if ($matches -ne 1) {
        $anchor = $Before.Substring(0, [Math]::Min(160, $Before.Length))
        throw "Unsupported workbench bundle: a core UI patch anchor is missing or ambiguous (matches: $matches; anchor: $anchor)."
    }
    return $Text.Replace($Before, $After)
}

function Update-ManagedKeyboardPolicy([string]$Text, [string]$Legacy, [string]$Current) {
    $anchor = 'this._currentlyDispatchingCommandId=l.commandId;'
    $count = [regex]::Matches($Text, [regex]::Escape($anchor)).Count
    if ($count -ne 1) { throw "Unsupported workbench bundle: keyboard dispatch anchor must be unique (matches: $count)." }
    $prefix = $anchor + "`n"
    $after = $prefix + $Current + 'try{'
    $policies = [regex]::Matches($Text, [regex]::Escape($prefix) + '(?<policy>[\s\S]*?)try\{')
    if ($policies.Count -gt 1) { throw 'Ambiguous managed keyboard policy: multiple dispatch anchors.' }
    if ($Text.Contains($after)) { return $Text }
    if ($policies.Count -eq 1) {
        $policy = $policies[0].Groups['policy'].Value
        # The generated search allow-list and basic-editing exceptions may
        # grow. All surrounding keyboard behavior must still match.
        $normalized = [regex]::Replace($policy, '(?m)^\t+const fileSearch = /[^\r\n;]+/;\r?\n', '')
        $normalized = $normalized.Replace(' && !fileSearch.test(command)', '')
        $legacyEditing = [regex]::Match($Legacy, '(?m)^\t+const basicEditing = /[^\r\n;]+/;').Value
        if ($legacyEditing) {
            $normalized = [regex]::Replace($normalized, '(?m)^\t+const basicEditing = /[^\r\n;]+/;', { param($match) $legacyEditing })
        }
        if ($normalized -ceq $Legacy) {
            return Replace-CoreSnippet $Text $policies[0].Value $after
        }
    }
    return Replace-CoreSnippet $Text 'this._currentlyDispatchingCommandId=l.commandId;try{' $after
}

function Assert-CurrentKeyboardPolicy([string]$Text, [string]$Legacy, [string]$Current) {
    if ((Update-ManagedKeyboardPolicy $Text $Legacy $Current) -cne $Text) {
        throw 'The runtime keyboard policy is outdated. Run node build.mjs setup.'
    }
}

function Get-SourcePatchNames($PatchDirectory = (Join-Path $ProjectRoot 'resources/patches')) {
    $manifest = Get-Content -LiteralPath (Join-Path $PatchDirectory 'series.json') -Raw | ConvertFrom-Json
    if ($manifest.version -ne 1 -or $manifest.patches -isnot [Array] -or !$manifest.patches.Count) { throw 'Invalid source patch manifest' }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($name in $manifest.patches) {
        if ($name -isnot [string] -or $name -cnotmatch '^[a-z0-9]+(?:-[a-z0-9]+)*\.patch$') { throw 'Invalid source patch filename' }
        if (!$seen.Add($name)) { throw "Duplicate source patch: $name" }
        if (!(Test-Path -LiteralPath (Join-Path $PatchDirectory $name) -PathType Leaf)) { throw "Missing source patch: $name" }
    }
    foreach ($file in (Get-ChildItem -LiteralPath $PatchDirectory -File -Filter '*.patch')) {
        if (!$seen.Contains($file.Name)) { throw "Unregistered source patch: $($file.Name)" }
    }
    return $manifest.patches
}

function Get-AppliedSourcePatches($SourceRoot, $PatchNames) {
    # Later patches can modify earlier hunks. Peel them from a disposable copy
    # in reverse order so repeat builds recognize the complete patch stack.
    $cache = Join-Path $ProjectRoot '.cache'
    $probeRoot = Join-Path $cache ('.source-patches-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $probeRoot | Out-Null
    $applied = [Collections.Generic.HashSet[string]]::new()
    try {
        # Isolate git apply from any enclosing checkout's path prefix.
        Invoke-Checked (Get-Command git).Source @('init', '--quiet', $probeRoot)
        foreach ($name in $PatchNames) {
            foreach ($line in [IO.File]::ReadAllLines((Join-Path $ProjectRoot "resources/patches/$name"))) {
                if (-not $line.StartsWith('+++ b/')) { continue }
                $relative = $line.Substring(6)
                $source = Join-Path $SourceRoot $relative
                $target = Join-Path $probeRoot $relative
                Assert-ChildPath $source $SourceRoot
                Assert-ChildPath $target $probeRoot
                if ((Test-Path -LiteralPath $source) -and -not (Test-Path -LiteralPath $target)) {
                    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
                    Copy-Item -LiteralPath $source -Destination $target
                }
            }
        }
        for ($i = $PatchNames.Count - 1; $i -ge 0; $i--) {
            $patch = Join-Path $ProjectRoot ('resources/patches/' + $PatchNames[$i])
            $oldPreference = $ErrorActionPreference
            try {
                $ErrorActionPreference = 'Continue'
                & git -C $probeRoot apply --reverse --check $patch 2>$null
                $canReverse = $LASTEXITCODE -eq 0
            } finally { $ErrorActionPreference = $oldPreference }
            if ($canReverse) {
                Invoke-Checked (Get-Command git).Source @('-C', $probeRoot, 'apply', '--reverse', $patch)
                [void]$applied.Add($PatchNames[$i])
            }
        }
        return ,$applied
    } finally { Remove-Managed $probeRoot $cache }
}

function Update-LegacyMinimalUiPatch($SourceRoot, $Patch, $commands = $null) {
    # Match only known menu-policy versions, preserving unrelated source edits.
    if (-not $commands) {
        $coding = "'ubovm.validateCodeChanges', 'ubovm.attachSelection', 'ubovm.reviewCodeChanges', "
        $editor = "'ubovm.expandFileEditor', 'ubovm.restoreFileEditor', "
        $projects = "'ubovm.newProject', 'ubovm.manageProjects', 'ubovm.newProjectConversation', 'ubovm.renameProject', 'ubovm.deleteProject', "
        $projectManager = "'ubovm.manageProjects', "
        foreach ($missing in @($projectManager, $projects, $coding, $editor, ($editor + $coding))) {
            if (Update-LegacyMinimalUiPatch $SourceRoot $Patch $missing) { return $true }
        }
        return $false
    }
    # Verify the entire known legacy patch before upgrading its one changed line.
    # Never reset the checkout or treat an arbitrary failed patch as already applied.
    $current = [IO.File]::ReadAllText($Patch)
    if ([regex]::Matches($current, [regex]::Escape($commands)).Count -ne 1) { return $false }
    $legacy = $current.Replace($commands, '')
    $cache = Join-Path $ProjectRoot '.cache'
    New-Item -ItemType Directory -Force -Path $cache | Out-Null
    $probe = Join-Path $cache ('.legacy-menu-' + [Guid]::NewGuid().ToString('N') + '.patch')
    try {
        [IO.File]::WriteAllText($probe, $legacy, [Text.UTF8Encoding]::new($false))
        $oldPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            & git -c "safe.directory=$SourceRoot" -C $SourceRoot apply --reverse --check $probe 2>$null
            $matches = $LASTEXITCODE -eq 0
        } finally { $ErrorActionPreference = $oldPreference }
        if (-not $matches) { return $false }
        $line = @($current -split "`r?`n" | Where-Object { $_.StartsWith('+') -and $_.Contains($commands) })
        if ($line.Count -ne 1) { return $false }
        $next = $line[0].Substring(1)
        $previous = $next.Replace($commands, '')
        $path = Join-Path $SourceRoot 'src/vs/platform/actions/common/actions.ts'
        $bytes = [IO.File]::ReadAllBytes($path)
        $source = [IO.File]::ReadAllText($path)
        if ([regex]::Matches($source, [regex]::Escape($previous)).Count -ne 1) { return $false }
        try {
            [IO.File]::WriteAllText($path, $source.Replace($previous, $next), [Text.UTF8Encoding]::new($false))
            Invoke-Checked (Get-Command git).Source @('-c', "safe.directory=$SourceRoot", '-C', $SourceRoot, 'apply', '--reverse', '--check', $Patch)
        } catch {
            [IO.File]::WriteAllBytes($path, $bytes)
            throw
        }
        return $true
    } finally { if (Test-Path -LiteralPath $probe) { Remove-Item -LiteralPath $probe -Force } }
}

function Update-LegacySidebarCloseTabsPatch($SourceRoot) {
    # Normalize the known pre-autorepeat version before peeling overlapping patches.
    $patch = Join-Path $ProjectRoot 'resources/patches/sidebar-close-tabs.patch'
    $current = [IO.File]::ReadAllText($patch)
    $guard = 'if (!event.repeat) { closeTab(); }'
    if ([regex]::Matches($current, [regex]::Escape($guard)).Count -ne 1) { return $false }
    $line = @($current -split "`r?`n" | Where-Object { $_.StartsWith('+') -and $_.Contains($guard) })
    if ($line.Count -ne 1) { return $false }
    $next = $line[0].Substring(1)
    $previous = $next.Replace($guard, 'closeTab();')
    $cache = Join-Path $ProjectRoot '.cache'
    New-Item -ItemType Directory -Force -Path $cache | Out-Null
    $probe = Join-Path $cache ('.legacy-sidebar-' + [Guid]::NewGuid().ToString('N') + '.patch')
    try {
        [IO.File]::WriteAllText($probe, $current.Replace($guard, 'closeTab();'), [Text.UTF8Encoding]::new($false))
        $oldPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            & git -c "safe.directory=$SourceRoot" -C $SourceRoot apply --reverse --check $probe 2>$null
            $matches = $LASTEXITCODE -eq 0
        } finally { $ErrorActionPreference = $oldPreference }
        if (-not $matches) { return $false }
        $path = Join-Path $SourceRoot 'src/vs/workbench/browser/parts/compositeBarActions.ts'
        $bytes = [IO.File]::ReadAllBytes($path)
        $source = [IO.File]::ReadAllText($path)
        if ([regex]::Matches($source, [regex]::Escape($previous)).Count -ne 1) { return $false }
        try {
            [IO.File]::WriteAllText($path, $source.Replace($previous, $next), [Text.UTF8Encoding]::new($false))
            Invoke-Checked (Get-Command git).Source @('-c', "safe.directory=$SourceRoot", '-C', $SourceRoot, 'apply', '--reverse', '--check', $patch)
        } catch {
            [IO.File]::WriteAllBytes($path, $bytes)
            throw
        }
        return $true
    } finally { if (Test-Path -LiteralPath $probe) { Remove-Item -LiteralPath $probe -Force } }
}

function Update-LegacySidebarModePatch($SourceRoot) {
    $legacy = Join-Path $ProjectRoot 'resources/patches/legacy/sidebar-mode-v1.patch'
    $patch = Join-Path $ProjectRoot 'resources/patches/sidebar-mode.patch'
    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & git -c "safe.directory=$SourceRoot" -C $SourceRoot apply --reverse --check $legacy 2>$null
        $matches = $LASTEXITCODE -eq 0
    } finally { $ErrorActionPreference = $oldPreference }
    if (-not $matches) { return $false }
    # Only a fully recognized historical patch can be replaced. Preserve all
    # other edits, and restore original bytes if the new patch cannot apply.
    $path = Join-Path $SourceRoot 'src/vs/workbench/browser/parts/views/treeView.ts'
    $bytes = [IO.File]::ReadAllBytes($path)
    $git = (Get-Command git).Source
    try {
        Invoke-Checked $git @('-c', "safe.directory=$SourceRoot", '-C', $SourceRoot, 'apply', '--reverse', $legacy)
        Invoke-Checked $git @('-c', "safe.directory=$SourceRoot", '-C', $SourceRoot, 'apply', '--check', $patch)
        Invoke-Checked $git @('-c', "safe.directory=$SourceRoot", '-C', $SourceRoot, 'apply', $patch)
        Invoke-Checked $git @('-c', "safe.directory=$SourceRoot", '-C', $SourceRoot, 'apply', '--reverse', '--check', $patch)
    } catch {
        [IO.File]::WriteAllBytes($path, $bytes)
        throw
    }
    return $true
}

function Get-PatchAdditions($Patch, $SourceFile) {
    $selected = $false
    $lines = foreach ($line in [IO.File]::ReadAllLines($Patch)) {
        if ($line.StartsWith('diff --git ')) { $selected = $line.EndsWith(' b/' + $SourceFile) }
        elseif ($selected -and $line.StartsWith('+') -and -not $line.StartsWith('+++')) { $line.Substring(1) }
    }
    return ($lines -join "`n") + "`n"
}

function Set-CoreChecksum($Product, $RelativeFile) {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $digest = [Convert]::ToBase64String($hasher.ComputeHash([IO.File]::ReadAllBytes((Join-Path $AppRoot ('out/' + $RelativeFile))))).TrimEnd('=') }
    finally { $hasher.Dispose() }
    $Product.checksums | Add-Member -NotePropertyName $RelativeFile -NotePropertyValue $digest -Force
}

function Get-WorkbenchStyle {
    $css = [IO.File]::ReadAllText((Join-Path $ProjectRoot 'src/renderer/workbench/workbench.css'))
    $logo = [IO.File]::ReadAllText((Join-Path $ProjectRoot 'src/renderer/media/icon.svg'))
    $uri = 'data:image/svg+xml;base64,' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($logo))
    $agentLock = @'

/* UBOVM browser agent-control lock */
.browser-root .browser-overlay-paused.agent-control.visible {
	pointer-events: all;
	cursor: not-allowed;
	background-color: color-mix(in srgb, var(--vscode-editor-background) 55%, transparent);
}
'@
    return $css.Replace('{{PRODUCT_LOGO_URI}}', $uri) + $agentLock
}

function Set-ProductBranding($Root) {
    if (-not $OnWindows) { return }
    $media = Join-Path $ProjectRoot 'src/renderer/media'
    $windowsResources = Join-Path $Root 'resources/win32'
    New-Item -ItemType Directory -Force -Path $windowsResources | Out-Null
    Copy-Item -LiteralPath (Join-Path $media 'app-icon.ico') -Destination (Join-Path $windowsResources 'code.ico') -Force
    foreach ($size in @(70, 150)) {
        Copy-Item -LiteralPath (Join-Path $media "app-icon-$size.png") -Destination (Join-Path $windowsResources "code_${size}x${size}.png") -Force
    }
}

function Set-StartupHtml($Path) {
    $html = [IO.File]::ReadAllText($Path)
    $html = [regex]::Replace($html, '(?s)<!-- UBOVM STARTUP BEGIN -->.*?<!-- UBOVM STARTUP END -->\s*', '')
    $body = [regex]::Match($html, '<body\b[^>]*>\s*')
    if (-not $body.Success) { throw "Missing workbench body: $Path" }
    $fragment = [IO.File]::ReadAllText((Join-Path $ProjectRoot 'src/renderer/workbench/startup.html'))
    $logo = [IO.File]::ReadAllText((Join-Path $ProjectRoot 'src/renderer/media/icon.svg'))
    $fragment = $fragment.Replace('{{PRODUCT_LOGO}}', $logo)
    $html = $html.Replace($body.Value, $body.Value.TrimEnd() + "`n" + $fragment.TrimEnd() + "`n")
    [IO.File]::WriteAllText($Path, $html, [Text.UTF8Encoding]::new($false))
}

function Set-FixedConversationCore($Product) {
    $bundlePath = Join-Path $AppRoot 'out/vs/workbench/workbench.desktop.main.js'
    $bundle = [IO.File]::ReadAllText($bundlePath)
    $bundle = Replace-CoreSnippet $bundle '_startBlockingIframeDragEvents(){' '_startBlockingIframeDragEvents(){if(this.providedViewType==="ubovm.welcome")return;'
    $bundle = $bundle.Replace("new Set(['ubovm.emptyFolder', 'ubovm.noWorkspace', 'ubovm.explorerEditing'])", "new Set(['ubovm.emptyFolder', 'ubovm.noWorkspace'])")
    $bundle = $bundle.Replace('&&this.contextKeyService.getContextKeyValue("ubovm.explorerEditing")!==true', '')
    $bundle = $bundle.Replace('get name(){if(this.explorerService.roots.length===1)return this.explorerService.roots[0].name;return this.labelService.getWorkspaceLabel(this.contextService.getWorkspace())}', 'get name(){return this.labelService.getWorkspaceLabel(this.contextService.getWorkspace())}')
    $bundle = $bundle.Replace('this.onDidChangeViewWelcomeState(); if (this._enabled) { this.render(); }', 'this.onDidChangeViewWelcomeState();')
    $bundle = $bundle.Replace("new Set(['ubovm.emptyFolder', 'ubovm.noWorkspace'])", "new Set(['ubovm.emptyFolder'])")
    $bundle = $bundle.Replace("new Set(['ubovm.emptyFolder', 'ubovm.noWorkspace', 'ubovm.explorerEditing'])", "new Set(['ubovm.emptyFolder'])")
    $bundle = $bundle.Replace('this.delegate.id==="workbench.explorer.fileView"&&this.contextKeyService.getContextKeyValue("ubovm.explorerEditing")!==true&&', 'this.delegate.id==="workbench.explorer.fileView"&&')
    $bundle = $bundle.Replace('&&(this.contextKeyService.getContextKeyValue("ubovm.emptyFolder")===true||this.contextKeyService.getContextKeyValue("ubovm.noWorkspace")===true)', '&&this.contextKeyService.getContextKeyValue("ubovm.emptyFolder")===true')
    # Keep the native explorer scoped to the active conversation without
    # changing the window workspace or restarting its extension host.
    $workspacePatch = Join-Path $ProjectRoot 'resources/patches/session-workspace.patch'
    $bundle = $bundle.Replace('t.length!==1||this.contextService.getWorkbenchState()!==2||t[0]?.error', 't.length!==1||t[0]?.error')
    # Empty windows still need the real Explorer view to instantiate its service.
    $bundle = Replace-CoreSnippet $bundle 'this.workspaceContextService.getWorkbenchState()===1||this.workspaceContextService.getWorkspace().folders.length===0?(r&&s.push(r),l||t.push(a)):(l&&s.push(l),r||t.push(o))' '/* UBOVM session explorer */(l&&s.push(l),r||t.push(o))'
    $workspaceCode = (Get-PatchAdditions $workspacePatch 'src/vs/workbench/contrib/files/browser/explorerService.ts')
    $workspaceCode = [regex]::Replace($workspaceCode, '(?m)^import .*\r?\n', '')
    $workspaceCode = $workspaceCode.Replace(': string | undefined', '').Replace(': string', '').Replace('CommandsRegistry', '$e').Replace('DisposableStore', 'O').Replace('URI.file', 'P.file').Replace('new ExplorerItem', 'new cm')
    $workspaceAnchor = 'this.disposables.add(this.model),'
    $bundle = Replace-CoreSnippet $bundle $workspaceAnchor ($workspaceAnchor + '(()=>{' + "`n" + $workspaceCode + '})(),')
    $bundle = $bundle.Replace('$e.registerCommand("_ubovm.initializeExplorer",accessor=>{accessor.get(ll)});', '')
    $bundle = Replace-CoreSnippet $bundle 'll=we("explorerService");' 'll=we("explorerService");$e.registerCommand("_ubovm.initializeExplorer",accessor=>{void accessor.get(ll).roots});'
    $keyboardPolicy = Get-PatchAdditions (Join-Path $ProjectRoot 'resources/patches/keyboard-policy.patch') 'src/vs/platform/keybinding/common/abstractKeybindingService.ts'
    $legacyKeyboardPolicy = $keyboardPolicy.Replace('resolveResult.commandId', 'l.commandId')
    $fileSearchPatch = Join-Path $ProjectRoot 'resources/patches/file-search.patch'
    $searchKeys = Get-PatchAdditions $fileSearchPatch 'src/vs/platform/keybinding/common/abstractKeybindingService.ts'
    $keyboardPolicy = [regex]::Replace($keyboardPolicy, '(?m)^.*if \(/\^\(\?:workbench.*\{\r?$', $searchKeys.TrimEnd())
    $keyboardPolicy = $keyboardPolicy.Replace('resolveResult.commandId', 'l.commandId')
    $bundle = Update-ManagedKeyboardPolicy $bundle $legacyKeyboardPolicy $keyboardPolicy
    $bundle = Replace-CoreSnippet $bundle 'findClosest(i){const e=this.contextService.getWorkspaceFolder(i);if(e){const t=this.roots.find(s=>this.uriIdentityService.extUri.isEqual(s.resource,e.uri));if(t)return t.find(i)}return null}' 'findClosest(i){const e=this.contextService.getWorkspaceFolder(i);if(e){const t=this.roots.find(s=>this.uriIdentityService.extUri.isEqual(s.resource,e.uri));if(t)return t.find(i)}const root=this.roots.filter(r=>this.uriIdentityService.extUri.isEqualOrParent(i,r.resource)).sort((a,b)=>b.resource.path.length-a.resource.path.length)[0];return root?.find(i)??null}'
    $bundle = Replace-CoreSnippet $bundle 'get name(){return this.labelService.getWorkspaceLabel(this.contextService.getWorkspace())}' 'get name(){if(this.explorerService.roots.length<=1)return this.explorerService.roots[0]?.name??"文件";return this.labelService.getWorkspaceLabel(this.contextService.getWorkspace())}'
    $bundle = Replace-CoreSnippet $bundle 'setContextKeys(e){const t=this.contextService.getWorkspace().folders,s=e?e.resource:t[t.length-1].uri;if(e=e||this.explorerService.findClosest(s),' 'setContextKeys(e){const t=this.explorerService.roots,s=e?e.resource:t[t.length-1]?.resource;if(e=e||(s?this.explorerService.findClosest(s):undefined),'
    $bundle = Replace-CoreSnippet $bundle 'const t=this.explorerService.roots;let s=t[0];(this.contextService.getWorkbenchState()!==2||t[0].error)&&(s=t);' 'const t=this.explorerService.roots;let s=t[0];this.updateTitle(this.name);(t.length!==1||t[0]?.error)&&(s=t);'
    # This exact anchor belongs to WebviewInput in the SHA-256-pinned runtime.
    # Refuse unknown versions instead of changing unrelated editor behavior.
    $original = 'get editorId(){return this.viewType}get capabilities(){return 138}get resource()'
    $patched = 'get editorId(){return this.viewType}get capabilities(){return this.viewType==="mainThreadWebview-ubovm.welcome"||this.viewType==="mainThreadWebview-ubovm.conversation"?12298:138}canMove(e,t){return e!==t&&(this.viewType==="mainThreadWebview-ubovm.welcome"||this.viewType==="mainThreadWebview-ubovm.conversation")?"The main conversation is a fixed workbench area.":super.canMove(e,t)}get resource()'
    if ($bundle.Contains($patched)) {
        Write-Host '[OK] Fixed main conversation core already applied'
    } elseif ([regex]::Matches($bundle, [regex]::Escape($original)).Count -eq 1) {
        $bundle = $bundle.Replace($original, $patched)
        Write-Host '[OK] Applied native CannotClose and fixed-group capabilities'
    } else {
        throw 'Unsupported workbench bundle: the fixed conversation patch requires the pinned runtime.'
    }
    # The additions in this patch are plain JavaScript except for the single
    # generic return cast; share the source policy with the pinned bundle.
    $uiPatch = Join-Path $ProjectRoot 'resources/patches/minimal-ui.patch'
    $menuPolicy = Get-PatchAdditions $uiPatch 'src/vs/platform/actions/common/actions.ts'
    $markdownPatch = Join-Path $ProjectRoot 'resources/patches/markdown-preview.patch'
    $markdownMenus = Get-PatchAdditions $markdownPatch 'src/vs/platform/actions/common/actions.ts'
    $menuPolicy = $menuPolicy.Replace('return result.filter', $markdownMenus + 'return result.filter')
    $searchMenus = Get-PatchAdditions $fileSearchPatch 'src/vs/platform/actions/common/actions.ts'
    $menuPolicy = [regex]::Replace($menuPolicy, '(?m)^.*return result.filter.*;\r?$', $searchMenus.TrimEnd())
    $beforeMenu = 'getMenuItems(i){let e;return this._menuItems.has(i)?e=[...this._menuItems.get(i)]:e=[],i===T.CommandPalette&&this._appendImplicitItems(e),e}'
    $ownedMenuPrefix = 'getMenuItems(i){let e;this._menuItems.has(i)?e=[...this._menuItems.get(i)]:e=[],i===T.CommandPalette&&this._appendImplicitItems(e);const id=i,result=e;'
    $ownedMenuStart = $bundle.IndexOf($ownedMenuPrefix)
    if ($ownedMenuStart -ge 0) {
        $ownedMenuEnd = $bundle.IndexOf('return result}', $ownedMenuStart)
        if ($ownedMenuEnd -lt 0) { throw 'Incomplete managed workbench menu policy.' }
        $bundle = $bundle.Substring(0, $ownedMenuStart) + $beforeMenu + $bundle.Substring($ownedMenuEnd + 'return result}'.Length)
    }
    $afterMenu = 'getMenuItems(i){let e;this._menuItems.has(i)?e=[...this._menuItems.get(i)]:e=[],i===T.CommandPalette&&this._appendImplicitItems(e);const id=i,result=e;' + "`n" + $menuPolicy + 'return result}'
    $bundle = Replace-CoreSnippet $bundle $beforeMenu $afterMenu
    $commandPolicy = (Get-PatchAdditions $uiPatch 'src/vs/workbench/services/commands/common/commandService.ts').Replace('undefined as T', 'undefined')
    $commandPolicy = $commandPolicy.Replace('|markdown\.showPreview', '')
    $searchCommands = Get-PatchAdditions $fileSearchPatch 'src/vs/workbench/services/commands/common/commandService.ts'
    $commandPolicy = [regex]::Replace($commandPolicy, '(?m)^.*if \(hiddenActions.test\(id\)\).*\{\r?$', $searchCommands.TrimEnd())
    $beforeCommand = 'async executeCommand(e,...t){this._logService.trace("CommandService#executeCommand",e);'
    $ownedCommandPrefix = 'async executeCommand(e,...t){const id=e;'
    $ownedCommandStart = $bundle.IndexOf($ownedCommandPrefix)
    if ($ownedCommandStart -ge 0) {
        $ownedCommandEnd = $bundle.IndexOf('this._logService.trace("CommandService#executeCommand",e);', $ownedCommandStart)
        if ($ownedCommandEnd -lt 0) { throw 'Incomplete managed command policy.' }
        $bundle = $bundle.Substring(0, $ownedCommandStart) + 'async executeCommand(e,...t){' + $bundle.Substring($ownedCommandEnd)
    }
    $afterCommand = 'async executeCommand(e,...t){const id=e;' + "`n" + $commandPolicy + 'this._logService.trace("CommandService#executeCommand",e);'
    $bundle = Replace-CoreSnippet $bundle $beforeCommand $afterCommand
    $bundle = Replace-CoreSnippet $bundle 'onTitleAreaContextMenu(e){if(this.shouldShowCompositeBar()' 'onTitleAreaContextMenu(e){return;/* UBOVM compact pane header */if(this.shouldShowCompositeBar()'
    $bundle = Replace-CoreSnippet $bundle 'onCompositeBarContextMenu(e){if(this.paneCompositeBar.value)' 'onCompositeBarContextMenu(e){return;/* UBOVM compact pane header */if(this.paneCompositeBar.value)'
    $bundle = Replace-CoreSnippet $bundle 'async run(e){const t=e.get(as);t.setPartHidden(t.isVisible("workbench.parts.panel"),"workbench.parts.panel")}' 'async run(e){const t=e.get(as);t.isVisible("workbench.parts.panel")?t.setPartHidden(true,"workbench.parts.panel"):await e.get(ui).openView("terminal",true)}'
    $bundle = Replace-CoreSnippet $bundle 'setGroupOrientation(e){if(!this.gridWidget)return;' 'get ubovmConversationGroup(){return this.groups.find(e=>e.editors.some(t=>t.editorId==="mainThreadWebview-ubovm.welcome"||t.editorId==="mainThreadWebview-ubovm.conversation"))}setGroupOrientation(e){if(this.ubovmConversationGroup&&e!==0)return;if(!this.gridWidget)return;'
    $bundle = Replace-CoreSnippet $bundle 'applyLayout(e){const t=this.shouldRestoreFocus(this.container);' 'applyLayout(e){if(this.ubovmConversationGroup){if(typeof e.orientation==="number"&&e.orientation!==0||e.groups.length<1||e.groups.length>2||e.groups.some(ubovmGroup=>Array.isArray(ubovmGroup.groups)))return;e={...e,orientation:0}}const t=this.shouldRestoreFocus(this.container);'
    $bundle = Replace-CoreSnippet $bundle 'addGroup(e,t,s){const n=this.assertGroupView(e);let o;if(n.groupsView===this){const r=this.shouldRestoreFocus(n.element),' 'addGroup(e,t,s){const n=this.assertGroupView(e);let o;if(n.groupsView===this){const ubovmMainGroup=this.ubovmConversationGroup;if(ubovmMainGroup){const ubovmFileGroup=this.groups.find(ubovmGroup=>ubovmGroup!==ubovmMainGroup);if(ubovmFileGroup)return ubovmFileGroup;t=3}const r=this.shouldRestoreFocus(n.element),'
    $bundle = Replace-CoreSnippet $bundle 'moveGroup(e,t,s){const n=this.assertGroupView(e),o=this.assertGroupView(t);if(n.id===o.id)throw new Error("Cannot move group into its own");const r=this.shouldRestoreFocus(n.element);' 'moveGroup(e,t,s){const n=this.assertGroupView(e),o=this.assertGroupView(t);if(n.id===o.id)throw new Error("Cannot move group into its own");const ubovmMainGroup=this.ubovmConversationGroup;if(ubovmMainGroup){if(n.groupsView!==this||o.groupsView!==this||n!==ubovmMainGroup&&o!==ubovmMainGroup)return n;s=n===ubovmMainGroup?2:3}const r=this.shouldRestoreFocus(n.element);'
    # The main conversation has no tabs or header and consumes no title height.
    $bundle = Replace-CoreSnippet $bundle 'this.headerControlDisposable=this._register(new ge),this.editorTabsControl=this.createEditorTabsControl()' 'this.headerControlDisposable=this._register(new ge),this.ubovmConversationChromeHidden=this.isUbovmConversationGroup(),this.editorTabsControl=this.createEditorTabsControl()'
    $bundle = Replace-CoreSnippet $bundle 'createEditorTabsControl(){let e;switch(this.groupsView.partOptions.showTabs)' 'isUbovmConversationGroup(){return this.groupView.editors.some(e=>e.editorId==="mainThreadWebview-ubovm.welcome"||e.editorId==="mainThreadWebview-ubovm.conversation")}updateConversationChrome(){const e=this.isUbovmConversationGroup();if(e===this.ubovmConversationChromeHidden)return;this.ubovmConversationChromeHidden=e,this.editorTabsControlDisposable.clear(),this.headerControlDisposable.clear(),ct(this.parent),this.editorTabsControl=this.createEditorTabsControl(),this.headerControl=this.createHeaderControl(),this.editorTabsControl.openEditors(this.groupView.editors),this.headerControl?.handleEditorsChange(!0),this.groupView.relayout()}createEditorTabsControl(){let e;switch(this.ubovmConversationChromeHidden?"none":this.groupsView.partOptions.showTabs)'
    $bundle = Replace-CoreSnippet $bundle 'createHeaderControl(){const e=this.instantiationService.createInstance(VCt,' 'createHeaderControl(){if(this.ubovmConversationChromeHidden)return;const e=this.instantiationService.createInstance(VCt,'
    $bundle = Replace-CoreSnippet $bundle 'openEditor(e,t){const s=this.editorTabsControl.openEditor(e,t);this.handleOpenedEditors(s)}openEditors(e){const t=this.editorTabsControl.openEditors(e);this.handleOpenedEditors(t)}handleOpenedEditors(e){this.headerControl.handleEditorsChange(e)}beforeCloseEditor(e){return this.editorTabsControl.beforeCloseEditor(e)}closeEditor(e){this.editorTabsControl.closeEditor(e),this.handleClosedEditors()}closeEditors(e){this.editorTabsControl.closeEditors(e),this.handleClosedEditors()}handleClosedEditors(){this.groupView.activeEditor||this.headerControl.handleEditorsChange(!0)}' 'openEditor(e,t){this.updateConversationChrome();const s=this.editorTabsControl.openEditor(e,t);this.handleOpenedEditors(s)}openEditors(e){this.updateConversationChrome();const t=this.editorTabsControl.openEditors(e);this.handleOpenedEditors(t)}handleOpenedEditors(e){this.headerControl?.handleEditorsChange(e)}beforeCloseEditor(e){return this.editorTabsControl.beforeCloseEditor(e)}closeEditor(e){this.updateConversationChrome(),this.editorTabsControl.closeEditor(e),this.handleClosedEditors()}closeEditors(e){this.updateConversationChrome(),this.editorTabsControl.closeEditors(e),this.handleClosedEditors()}handleClosedEditors(){this.groupView.activeEditor||this.headerControl?.handleEditorsChange(!0)}'
    $bundle = Replace-CoreSnippet $bundle 'updateEditorLabel(e){this.editorTabsControl.updateEditorLabel(e),this.groupView.activeEditor===e&&this.headerControl.handleEditorsChange(!0)}' 'updateEditorLabel(e){this.editorTabsControl.updateEditorLabel(e),this.groupView.activeEditor===e&&this.headerControl?.handleEditorsChange(!0)}'
    $bundle = Replace-CoreSnippet $bundle 'layout(e){return this.editorTabsControl.layout(e),this.headerControl.layout(e.container.width),new Ei(e.container.width,this.getHeight().total)}getHeight(){const e=this.editorTabsControl.getHeight();return{total:e+this.headerControl.height,offset:e}}' 'layout(e){return this.editorTabsControl.layout(e),this.headerControl?.layout(e.container.width),new Ei(e.container.width,this.getHeight().total)}getHeight(){const e=this.editorTabsControl.getHeight();return{total:e+(this.headerControl?.height??0),offset:e}}'
    # Preserve explicit terminal focus through the view-to-container bridge.
    $bundle = Replace-CoreSnippet $bundle 'const r=await this.openComposite(o.id,n);if(r?.openView)' 'const r=await this.openComposite(o.id,n,e==="terminal"?t:void 0);if(r?.openView)'
    # Normalize the managed reveal guard before matching the complete panel policy.
    $bundle = $bundle.Replace('if(t!==true&&!this.layoutService.isVisible("workbench.parts.panel"))return;return super.openPaneComposite(e??this.getLastActivePaneCompositeId(),t)', 'return super.openPaneComposite(e??this.getLastActivePaneCompositeId(),t)')
    # Upgrade the terminal-only policy before installing the shared Worker panel policy.
    $bundle = $bundle.Replace('static{this.activePanelSettingsKey="workbench.panelpart.activepanelid"}async openPaneComposite(e,t){if(e!==void 0&&e!=="terminal")return;return super.openPaneComposite("terminal",t)}getPaneComposite(e){return e==="terminal"?super.getPaneComposite(e):void 0}getPaneComposites(){return super.getPaneComposites().filter(e=>e.id==="terminal")}getLastActivePaneCompositeId(){return"terminal"}', 'static{this.activePanelSettingsKey="workbench.panelpart.activepanelid"}')
    $bundle = Replace-CoreSnippet $bundle 'static{this.activePanelSettingsKey="workbench.panelpart.activepanelid"}' 'static{this.activePanelSettingsKey="workbench.panelpart.activepanelid"}async openPaneComposite(e,t){if(e!==void 0&&e!=="terminal"&&e!=="workbench.view.extension.ubovm-workers")return;return super.openPaneComposite(e??this.getLastActivePaneCompositeId(),t)}getPaneComposite(e){return e==="terminal"||e==="workbench.view.extension.ubovm-workers"?super.getPaneComposite(e):void 0}getPaneComposites(){return super.getPaneComposites().filter(e=>e.id==="terminal"||e.id==="workbench.view.extension.ubovm-workers")}getLastActivePaneCompositeId(){const e=super.getLastActivePaneCompositeId();return e==="workbench.view.extension.ubovm-workers"?e:"terminal"}'
    $bundle = $bundle.Replace('shouldShowCompositeBar(){return!1}getCompositeBarPosition(){return Ad.TITLE}toJSON(){return{type:"workbench.parts.panel"}}', 'shouldShowCompositeBar(){return!0}getCompositeBarPosition(){return Ad.TITLE}toJSON(){return{type:"workbench.parts.panel"}}')
    $bundle = Replace-CoreSnippet $bundle 'shouldBeHidden(e,t){const s=Oe(e)?this.getViewContainer(e):e,n=Oe(e)?e:e.id;' 'shouldBeHidden(e,t){const s=Oe(e)?this.getViewContainer(e):e,n=Oe(e)?e:e.id;if(this.options.partContainerClass==="panel"&&n!=="terminal"&&n!=="workbench.view.extension.ubovm-workers")return!0;'
    # Do not strip Blackboard from the current sidebar allow-list; that suffix
    # is also the end of the finished explorer/search/browser policy.
    if (-not $bundle.Contains('n!=="workbench.view.extension.ubovm-browser"&&n!=="workbench.view.extension.ubovm-workers"&&n!=="workbench.view.extension.ubovm-blackboard")return!0;')) {
        $bundle = $bundle.Replace('&&n!=="workbench.view.extension.ubovm-workers"&&n!=="workbench.view.extension.ubovm-blackboard")return!0;', '&&n!=="workbench.view.extension.ubovm-workers")return!0;')
    }
    $bundle = Replace-CoreSnippet $bundle 'if(this.options.partContainerClass==="panel"&&n!=="terminal"&&n!=="workbench.view.extension.ubovm-workers")return!0;' 'if(this.options.partContainerClass==="panel"&&n!=="terminal"&&n!=="workbench.view.extension.ubovm-workers")return!0;if(this.options.partContainerClass==="sidebar"&&n!=="workbench.view.explorer"&&n!=="workbench.view.extension.ubovm-workers")return!0;'
    $bundle = Replace-CoreSnippet $bundle 'partContainerClass:"sidebar",pinnedViewContainersKey:FZ.pinnedViewContainersKey,placeholderViewContainersKey:FZ.placeholderViewContainersKey,viewContainersWorkspaceStateKey:FZ.viewContainersWorkspaceStateKey,icon:!0' 'partContainerClass:"sidebar",pinnedViewContainersKey:FZ.pinnedViewContainersKey,placeholderViewContainersKey:FZ.placeholderViewContainersKey,viewContainersWorkspaceStateKey:FZ.viewContainersWorkspaceStateKey,icon:!1'
    # Right-side tabs share the title row so single-view logs do not repeat their title.
    $bundle = Replace-CoreSnippet $bundle 'getCompositeBarPosition(){switch(this.configurationService.getValue("workbench.activityBar.location")){case"top":return Ad.TOP;' 'getCompositeBarPosition(){switch(this.configurationService.getValue("workbench.activityBar.location")){case"top":return Ad.TITLE;'
    $closeStart = $bundle.IndexOf('render(e){super.render(e),this.updateChecked(),this.updateEnabled();const container=e;')
    if ($closeStart -ge 0) {
        $closeEnd = $bundle.IndexOf('this._register(U(this.container,ie.CONTEXT_MENU,', $closeStart)
        if ($closeEnd -lt 0 -or !$bundle.Substring($closeStart, $closeEnd - $closeStart).Contains('ubovm-sidebar-tab-close')) { throw 'Unsupported sidebar close-tab patch.' }
        $bundle = $bundle.Substring(0, $closeStart) + 'render(e){super.render(e),this.updateChecked(),this.updateEnabled(),' + $bundle.Substring($closeEnd)
    }
    $closeTabs = Get-PatchAdditions (Join-Path $ProjectRoot 'resources/patches/sidebar-close-tabs.patch') 'src/vs/workbench/browser/parts/compositeBarActions.ts'
    $closeTabs = $closeTabs.Replace("if (!container.closest('.part.sidebar')) { return; }", "const sidebar = container.closest('.part.sidebar'); if (!sidebar) { return; }").Replace("void this.commandService.executeCommand('workbench.action.closeSidebar');", "sidebar.dispatchEvent(new CustomEvent('ubovm-empty-sidebar'));")
    $closeTabs = $closeTabs.Replace('querySelector<HTMLElement>', 'querySelector').Replace('addDisposableListener(', 'U(').Replace('localize(''ubovm.closeSidebarTab'', "关闭 {0}", this.compositeBarActionItem.name)', '(''关闭 '' + this.compositeBarActionItem.name)')
    $bundle = Replace-CoreSnippet $bundle 'render(e){super.render(e),this.updateChecked(),this.updateEnabled(),this._register(U(this.container,ie.CONTEXT_MENU,' ('render(e){super.render(e),this.updateChecked(),this.updateEnabled();const container=e;' + "`n" + $closeTabs + 'this._register(U(this.container,ie.CONTEXT_MENU,')
    $bundle = Replace-CoreSnippet $bundle 'onDidViewContainerVisible(e){const t=this.getViewContainer(e);t&&(this.addComposite(t),this.compositeBar.activateComposite(t.id),' 'onDidViewContainerVisible(e){const t=this.getViewContainer(e);t&&(this.addComposite(t),this.options.partContainerClass==="sidebar"&&this.compositeBar.pin(e),this.compositeBar.activateComposite(t.id),'
    $emptySidebar = Get-PatchAdditions (Join-Path $ProjectRoot 'resources/patches/sidebar-empty.patch') 'src/vs/workbench/browser/parts/paneCompositePart.ts'
    $emptyMethod = [regex]::Match($emptySidebar, '(?s)\tprivate initializeUbovmEmptySidebar\(\): void \{.*?\n\t\}').Value
    if (-not $emptyMethod) { throw 'Missing empty sidebar implementation.' }
    $emptyMethod = $emptyMethod.Replace('private ', '').Replace('(): void', '()').Replace('addDisposableListener(', 'U(')
    # Soft last-tab close: keep the empty CTA visible; do not auto-hide the sidebar part.
    $autoHideMethod = $emptyMethod.Replace('fileButton.focus();', 'this.hideActivePaneComposite();').Replace('button.focus();', 'this.hideActivePaneComposite();')
    if ($bundle.Contains($autoHideMethod)) { $bundle = $bundle.Replace($autoHideMethod, $emptyMethod) }
    $existingEmpty = [regex]::Match($bundle, 'initializeUbovmEmptySidebar\(\)\{.*?\n\t\}', [System.Text.RegularExpressions.RegexOptions]::Singleline)
    if ($existingEmpty.Success -and -not $existingEmpty.Value.Contains('ubovm-empty-sidebar-chooser')) {
        $bundle = $bundle.Substring(0, $existingEmpty.Index) + $emptyMethod.TrimStart() + $bundle.Substring($existingEmpty.Index + $existingEmpty.Length)
    }
    if (-not $bundle.Contains('initializeUbovmEmptySidebar(){') -and -not $bundle.Contains('initializeUbovmEmptySidebar() {')) {
        $bundle = Replace-CoreSnippet $bundle 'createEmptyPaneMessage(e){' ($emptyMethod + "`n" + 'createEmptyPaneMessage(e){')
    }
    $bundle = Replace-CoreSnippet $bundle 'this.createEmptyPaneMessage(this.contentArea),this.updateCompositeBar();' 'this.createEmptyPaneMessage(this.contentArea),this.updateCompositeBar();this.initializeUbovmEmptySidebar();'
    $bundle = Replace-CoreSnippet $bundle 'onDidOpen(e){const t=e.getId();' 'onDidOpen(e){if(this.partId==="workbench.parts.sidebar"){delete this.element.dataset.ubovmEmpty;this.storageService.remove("ubovm.sidebar.empty",1)}const t=e.getId();'
    $bundle = Replace-CoreSnippet $bundle 'getLastActivePaneCompositeId(){return this.getLastActiveCompositeId()}' 'getLastActivePaneCompositeId(){if(this.partId==="workbench.parts.sidebar"&&this.element.dataset.ubovmEmpty==="true")return"";return this.getLastActiveCompositeId()}'
    $bundle = Replace-CoreSnippet $bundle 'if(this.options.partContainerClass==="sidebar"&&n!=="workbench.view.explorer"&&n!=="workbench.view.extension.ubovm-workers")return!0;' 'if(this.options.partContainerClass==="sidebar"&&n!=="workbench.view.explorer"&&n!=="workbench.view.search"&&n!=="workbench.view.extension.ubovm-browser"&&n!=="workbench.view.extension.ubovm-workers"&&n!=="workbench.view.extension.ubovm-blackboard")return!0;'
    $bundle = Replace-CoreSnippet $bundle 'if(this.options.partContainerClass==="sidebar"&&n!=="workbench.view.explorer"&&n!=="workbench.view.extension.ubovm-workers"&&n!=="workbench.view.extension.ubovm-blackboard")return!0;' 'if(this.options.partContainerClass==="sidebar"&&n!=="workbench.view.explorer"&&n!=="workbench.view.search"&&n!=="workbench.view.extension.ubovm-browser"&&n!=="workbench.view.extension.ubovm-workers"&&n!=="workbench.view.extension.ubovm-blackboard")return!0;'
    $bundle = Replace-CoreSnippet $bundle 'if(this.options.partContainerClass==="sidebar"&&n!=="workbench.view.explorer"&&n!=="workbench.view.search"&&n!=="workbench.view.extension.ubovm-workers"&&n!=="workbench.view.extension.ubovm-blackboard")return!0;' 'if(this.options.partContainerClass==="sidebar"&&n!=="workbench.view.explorer"&&n!=="workbench.view.search"&&n!=="workbench.view.extension.ubovm-browser"&&n!=="workbench.view.extension.ubovm-workers"&&n!=="workbench.view.extension.ubovm-blackboard")return!0;'
    $bundle = $bundle.Replace(
      "['workbench.view.explorer', 'workbench.view.extension.ubovm-workers', 'workbench.view.extension.ubovm-blackboard']",
      "['workbench.view.explorer', 'workbench.view.search', 'workbench.view.extension.ubovm-browser', 'workbench.view.extension.ubovm-workers', 'workbench.view.extension.ubovm-blackboard']")
    $bundle = $bundle.Replace(
      '["workbench.view.explorer","workbench.view.extension.ubovm-workers","workbench.view.extension.ubovm-blackboard"]',
      '["workbench.view.explorer","workbench.view.search","workbench.view.extension.ubovm-browser","workbench.view.extension.ubovm-workers","workbench.view.extension.ubovm-blackboard"]')
    $bundle = $bundle.Replace(
      "['workbench.view.explorer', 'workbench.view.search', 'workbench.view.extension.ubovm-workers', 'workbench.view.extension.ubovm-blackboard']",
      "['workbench.view.explorer', 'workbench.view.search', 'workbench.view.extension.ubovm-browser', 'workbench.view.extension.ubovm-workers', 'workbench.view.extension.ubovm-blackboard']")
    $bundle = $bundle.Replace(
      '["workbench.view.explorer","workbench.view.search","workbench.view.extension.ubovm-workers","workbench.view.extension.ubovm-blackboard"]',
      '["workbench.view.explorer","workbench.view.search","workbench.view.extension.ubovm-browser","workbench.view.extension.ubovm-workers","workbench.view.extension.ubovm-blackboard"]')
    $startupCode = (Get-PatchAdditions (Join-Path $ProjectRoot 'resources/patches/startup-ui.patch') 'src/vs/workbench/contrib/splash/browser/partsSplash.ts').Replace('mainWindow', 'et')
    $startupStart = $bundle.IndexOf('_removePartsSplash(){')
    if ($startupStart -lt 0) { throw 'Unsupported workbench bundle: the startup transition anchor is missing.' }
    $startupEnd = $bundle.IndexOf('const e=et.document.getElementById(Vni._splashElementId);', $startupStart)
    if ($startupStart -ge 0 -and $startupEnd -gt $startupStart -and $bundle.Substring($startupStart, $startupEnd - $startupStart).Contains('ubovm-startup')) {
        $bundle = $bundle.Substring(0, $startupStart) + '_removePartsSplash(){' + $bundle.Substring($startupEnd)
    }
    $bundle = Replace-CoreSnippet $bundle '_removePartsSplash(){const e=et.document.getElementById(Vni._splashElementId);' ('_removePartsSplash(){' + "`n" + $startupCode + 'const e=et.document.getElementById(Vni._splashElementId);')
    # Colors are removed inside the injected finish()/else path; drop the immediate strip.
    $bundle = $bundle.Replace('const t=et.document.head.getElementsByClassName("initialShellColors");t[0]?.remove()', '')
    # Keep source and pinned prebuilt startup width recovery identical.
    $sidebarSizeCode = (Get-PatchAdditions (Join-Path $ProjectRoot 'resources/patches/sidebar-size.patch') 'src/vs/workbench/browser/layout.ts').Replace('LayoutStateKeys.', 'Ti.').Replace('width * 0.4', 'this._mainContainerDimension.width * 0.4').Replace('width / 4', 'this._mainContainerDimension.width / 4')
    if (-not $bundle.Contains('// Repair oversized persisted sidebars')) {
        $bundle = Replace-CoreSnippet $bundle 'createGridDescriptor(){const{width:i,height:e}' ('createGridDescriptor(){' + "`n" + $sidebarSizeCode + 'const{width:i,height:e}')
    }
    $bundle = Replace-CoreSnippet $bundle 'return super.openPaneComposite(e??this.getLastActivePaneCompositeId(),t)' 'if(t!==true&&!this.layoutService.isVisible("workbench.parts.panel"))return;return super.openPaneComposite(e??this.getLastActivePaneCompositeId(),t)'
    $bundle = Replace-CoreSnippet $bundle 'createGridDescriptor(){' 'createGridDescriptor(){this.stateModel.setRuntimeValue(Ti.SIDEBAR_HIDDEN,!0);'
    $bundle = Replace-CoreSnippet $bundle 'this.state.initialization.views.containerToRestore.sideBar&&(hs("code/willRestoreViewlet")' 'this.isVisible("workbench.parts.sidebar")&&this.state.initialization.views.containerToRestore.sideBar&&(hs("code/willRestoreViewlet")'
    # Reserve real virtual-list space for conversation rows only.
    $panelPatch = Join-Path $ProjectRoot 'resources/patches/panel-ui.patch'
    $motionCode = (Get-PatchAdditions $panelPatch 'src/vs/workbench/browser/layout.ts').Replace(' as HTMLElement | null', '').Replace(' as HTMLElement', '')
    $motionStart = $bundle.IndexOf('setPartHidden(i,e){const hidden=i,part=e;')
    if ($motionStart -ge 0) {
        $motionEnd = $bundle.IndexOf('switch(e)', $motionStart)
        if ($motionEnd -lt 0) { throw 'Incomplete managed panel animation.' }
        $bundle = $bundle.Substring(0, $motionStart) + 'setPartHidden(i,e){' + $bundle.Substring($motionEnd)
    }
    $bundle = Replace-CoreSnippet $bundle 'setPartHidden(i,e){switch(e)' ('setPartHidden(i,e){const hidden=i,part=e;' + "`n" + $motionCode + 'switch(e)')
    $terminalLoadingCode = Get-PatchAdditions $panelPatch 'src/vs/workbench/contrib/terminal/browser/terminalView.ts'
    $terminalLoadingStart = $bundle.IndexOf('/* UBOVM TERMINAL LOADING BEGIN */')
    if ($terminalLoadingStart -ge 0) {
        $terminalLoadingEnd = $bundle.IndexOf('/* UBOVM TERMINAL LOADING END */', $terminalLoadingStart)
        if ($terminalLoadingEnd -lt 0) { throw 'Incomplete managed terminal loading indicator.' }
        $bundle = $bundle.Substring(0, $terminalLoadingStart) + $bundle.Substring($terminalLoadingEnd + '/* UBOVM TERMINAL LOADING END */'.Length)
    }
    $terminalLoadingAnchor = 'this._parentDomElement.classList.add("integrated-terminal"),'
    $terminalLoadingReplacement = $terminalLoadingAnchor + '/* UBOVM TERMINAL LOADING BEGIN */(()=>{const container=this._parentDomElement;' + "`n" + $terminalLoadingCode + '})(),/* UBOVM TERMINAL LOADING END */'
    $bundle = Replace-CoreSnippet $bundle $terminalLoadingAnchor $terminalLoadingReplacement
    $welcomeCode = Get-PatchAdditions $panelPatch 'src/vs/workbench/browser/parts/views/viewPane.ts'
    $welcomeParts = $welcomeCode -split '(?m)^\s*const enabled = .*;\r?\n', 2
    if ($welcomeParts.Count -ne 2) { throw 'Unsupported panel welcome patch structure.' }
    $bundle = Replace-CoreSnippet $bundle ',this.disposables.add(r.onWillShutdown(()=>this.dispose()))}layout(e,t)' (';' + $welcomeParts[0] + 'this.disposables.add(r.onWillShutdown(()=>this.dispose()))}layout(e,t)')
    $bundle = Replace-CoreSnippet $bundle 'onDidChangeViewWelcomeState(){const e=this.delegate.shouldShowWelcome();' 'onDidChangeViewWelcomeState(){const e=this.delegate.shouldShowWelcome()||(this.delegate.id==="workbench.explorer.fileView"&&this.contextKeyService.getContextKeyValue("ubovm.emptyFolder")===true);'
    $welcomeStart = $bundle.IndexOf("getContentDescriptors(){`n")
    if ($welcomeStart -ge 0) {
        $welcomeEnd = $bundle.IndexOf('const e=this.items.filter(t=>t.visible);', $welcomeStart)
        if ($welcomeEnd -lt 0) { throw 'Incomplete managed panel welcome content.' }
        $bundle = $bundle.Substring(0, $welcomeStart) + 'getContentDescriptors(){' + $bundle.Substring($welcomeEnd)
    }
    $bundle = Replace-CoreSnippet $bundle 'getContentDescriptors(){const e=this.items.filter(t=>t.visible);' ('getContentDescriptors(){' + "`n" + $welcomeParts[1] + 'const e=this.items.filter(t=>t.visible);')
    $bundle = $bundle.Replace("new Set(['ubovm.emptyFolder'])", "new Set(['ubovm.emptyFolder', 'ubovm.noWorkspace'])")
    $bundle = $bundle.Replace("if (event.affectsSome(new Set(['ubovm.emptyFolder', 'ubovm.noWorkspace']))) { this.onDidChangeViewWelcomeState(); }", "if (event.affectsSome(new Set(['ubovm.emptyFolder', 'ubovm.noWorkspace']))) { this.onDidChangeViewWelcomeState(); if (this._enabled) { this.render(); } }")
    $bundle = $bundle.Replace('&&this.contextKeyService.getContextKeyValue("ubovm.emptyFolder")===true', '&&(this.contextKeyService.getContextKeyValue("ubovm.emptyFolder")===true||this.contextKeyService.getContextKeyValue("ubovm.noWorkspace")===true)')
    $noWorkspaceContent = 'if(this.delegate.id==="workbench.explorer.fileView"&&this.contextKeyService.getContextKeyValue("ubovm.noWorkspace")===true){return [{content:"$(folder-opened)\n尚未选择工作空间\n请在当前会话顶部选择工作空间，文件列表将随会话自动更新。"}];}'
    $bundle = $bundle.Replace("getContentDescriptors(){`n", "getContentDescriptors(){`n" + $noWorkspaceContent)
    # Inline file/folder creation must take precedence over the empty-folder welcome.
    $bundle = $bundle.Replace("new Set(['ubovm.emptyFolder', 'ubovm.noWorkspace'])", "new Set(['ubovm.emptyFolder', 'ubovm.noWorkspace', 'ubovm.explorerEditing'])")
    $bundle = Replace-CoreSnippet $bundle 'this.folderContext=Hh.bindTo(u),' 'this.ubovmEditingContext=u.createKey("ubovm.explorerEditing",false),this.folderContext=Hh.bindTo(u),'
    $bundle = Replace-CoreSnippet $bundle 'async setEditable(e,t){t?(this.horizontalScrolling=' 'async setEditable(e,t){this.ubovmEditingContext.set(t);t?(this.horizontalScrolling='
    $bundle = Replace-CoreSnippet $bundle 'this.delegate.id==="workbench.explorer.fileView"&&(this.contextKeyService.getContextKeyValue("ubovm.emptyFolder")' 'this.delegate.id==="workbench.explorer.fileView"&&this.contextKeyService.getContextKeyValue("ubovm.explorerEditing")!==true&&(this.contextKeyService.getContextKeyValue("ubovm.emptyFolder")'
    $modeCode = (Get-PatchAdditions (Join-Path $ProjectRoot 'resources/patches/sidebar-mode.patch') 'src/vs/workbench/browser/parts/views/treeView.ts').Replace(': KeyboardEvent', '').Replace(': globalThis.Event', '').Replace('<HTMLElement, boolean>', '').Replace(': Event', '').Replace(' as Node', '').Replace(': number | undefined', '').Replace(': HTMLButtonElement[]', '').Replace(': boolean', '')
    # Prebuilt injection must stay plain JS; reject leftover parameter type annotations.
    if ($modeCode -match '(?m)(?:\(|,\s*)[A-Za-z_$][\w$]*\s*:\s*[A-Za-z_$]') { throw 'sidebar-mode patch still contains TypeScript parameter types after stripping; update Set-FixedConversationCore.' }
    $modeLayoutPattern = '(?m)^\s*if \(this.id === ''ubovm.sessions''\) \{ height = Math.max\(0, height - (?<reserved>\d+)\); \}\s*$'
    $modeLayout = [regex]::Match($modeCode, $modeLayoutPattern)
    $modeParts = [regex]::Split($modeCode, $modeLayoutPattern.Replace('(?<reserved>\d+)', '\d+'))
    if ($modeParts.Count -ne 2) { throw 'Unsupported sidebar mode patch structure.' }
    $modeStart = $bundle.IndexOf('renderBody(e){this._container=e;const container=e;')
    if ($modeStart -ge 0) {
        $modeEnd = $bundle.IndexOf('super.renderBody(e);this.renderTreeView(e)}', $modeStart)
        if ($modeEnd -lt 0) { throw 'Incomplete managed sidebar mode controls.' }
        $bundle = $bundle.Substring(0, $modeStart) + 'renderBody(e){this._container=e,super.renderBody(e),this.renderTreeView(e)}' + $bundle.Substring($modeEnd + 'super.renderBody(e);this.renderTreeView(e)}'.Length)
    }
    $bundle = Replace-CoreSnippet $bundle 'renderBody(e){this._container=e,super.renderBody(e),this.renderTreeView(e)}' ('renderBody(e){this._container=e;const container=e;' + "`n" + $modeParts[0] + 'super.renderBody(e);this.renderTreeView(e)}')
    # Normalize previously installed sidebar reservations before applying the current patch.
    $bundle = [regex]::Replace($bundle, 'layoutBody\(e,t\)\{if\(this.id==="ubovm.sessions"\)e=Math.max\(0,e-\d+\);super.layoutBody\(e,t\),this.layoutTreeView\(e,t\)\}', 'layoutBody(e,t){super.layoutBody(e,t),this.layoutTreeView(e,t)}')
    $bundle = Replace-CoreSnippet $bundle 'layoutBody(e,t){super.layoutBody(e,t),this.layoutTreeView(e,t)}' ('layoutBody(e,t){if(this.id==="ubovm.sessions")e=Math.max(0,e-' + $modeLayout.Groups['reserved'].Value + ');super.layoutBody(e,t),this.layoutTreeView(e,t)}')
    $bundle = Replace-CoreSnippet $bundle 'this.instantiationService.createInstance(c6n,this.id,this.treeContainer,new h6n,[r],s,' 'this.instantiationService.createInstance(c6n,this.id,this.treeContainer,new h6n(this.id),[r],s,'
    $bundle = Replace-CoreSnippet $bundle 'h6n=class{getHeight(i){return Ut.sidebarSize22}getTemplateId(i){return CNe.TREE_TEMPLATE_ID}}' 'h6n=class{constructor(i){this.viewId=i}getHeight(i){return this.viewId==="ubovm.sessions"?44:Ut.sidebarSize22}getTemplateId(i){return CNe.TREE_TEMPLATE_ID}}'
    $bundle = Replace-CoreSnippet $bundle 'this.treeContainer=E(this.domNode,x(".customview-tree")),this.treeContainer.classList.add("file-icon-themable-tree","show-file-icons")' 'this.treeContainer=E(this.domNode,x(".customview-tree")),this.treeContainer.classList.add("file-icon-themable-tree","show-file-icons"),this.treeContainer.classList.toggle("ubovm-session-tree",this.id==="ubovm.sessions")'
    # Reserve the taller header in the native grid and Electron overlay layout.
    $bundle = Replace-CoreSnippet $bundle 'get minimumHeight(){const e=oi&&fke();let t=this.isCommandCenterVisible||e?Jxe:30;' 'get minimumHeight(){const e=oi&&fke();let t=Math.max(44,this.isCommandCenterVisible||e?Jxe:30);'
    # Agent-control lock for Integrated Browser: hide WCV + show read-only overlay.
    $bundle = Replace-CoreSnippet $bundle '_shouldShowPage(){return this._editorVisible&&!this._overlayObscured&&!!this._model?.url&&!this._model?.error}' '_shouldShowPage(){return this._editorVisible&&!this._overlayObscured&&!globalThis.__ubovmBrowserAgentLock&&!!this._model?.url&&!this._model?.error}'
    $bundle = Replace-CoreSnippet $bundle '_refresh(){const e=!!this._model?.url&&!this._model?.error;this._placeholderScreenshot.style.display=e?"":"none";const t=!!this._model?.url&&this._editorVisible&&this._overlayObscured;if(this._overlayPauseEl.classList.toggle("visible",t),!this._model)return;' '_refresh(){const e=!!this._model?.url&&!this._model?.error;this._placeholderScreenshot.style.display=e?"":"none";const agentLock=!!globalThis.__ubovmBrowserAgentLock,t=!!this._model?.url&&this._editorVisible&&(this._overlayObscured||agentLock);if(this._overlayPauseEl.classList.toggle("agent-control",agentLock),agentLock){const heading=this._overlayPauseEl.querySelector(".browser-overlay-paused-heading"),detail=this._overlayPauseEl.querySelector(".browser-overlay-paused-detail");heading&&(heading.textContent=globalThis.__ubovmBrowserAgentLockReason||"Agent 正在操作浏览器（只读）"),detail&&(detail.textContent="Agent 操作完成前页面只读，请勿点击。"),this._overlayPauseEl.classList.add("show-message")}if(this._overlayPauseEl.classList.toggle("visible",t),!this._model)return;'
    $bundle = Replace-CoreSnippet $bundle 'this._register(this._overlayManager.onDidChangeOverlayState(()=>this._refreshOverlayObscured())),this._refresh()}' 'this._register(this._overlayManager.onDidChangeOverlayState(()=>this._refreshOverlayObscured())),this._register((()=>{const refresh=()=>this._refresh();return window.addEventListener("ubovm-browser-agent-lock",refresh),{dispose:()=>window.removeEventListener("ubovm-browser-agent-lock",refresh)}})()),this._refresh()}'
    $browserLockCommand = '$e.registerCommand("workbench.action.browser.setAgentControlLock",(accessor,locked,reason)=>{globalThis.__ubovmBrowserAgentLock=locked===!0,globalThis.__ubovmBrowserAgentLockReason=typeof reason==="string"&&reason.trim()?reason.trim():"Agent 正在操作浏览器（只读）";try{window.dispatchEvent(new CustomEvent("ubovm-browser-agent-lock"))}catch{}});'
    if (-not $bundle.Contains('workbench.action.browser.setAgentControlLock')) {
        $bundle = Replace-CoreSnippet $bundle 'registerContribution(eni);' ('registerContribution(eni);' + $browserLockCommand)
    }
    [IO.File]::WriteAllText($bundlePath, $bundle, [Text.UTF8Encoding]::new($false))
    Set-CoreChecksum $Product 'vs/workbench/workbench.desktop.main.js'
    # The same stylesheet is appended to the source and compiled workbench.
    $cssPath = Join-Path $AppRoot 'out/vs/workbench/workbench.desktop.main.css'
    $css = [IO.File]::ReadAllText($cssPath)
    $cssMarker = '/* UBOVM COMPACT WORKBENCH */'
    $offset = $css.IndexOf($cssMarker)
    if ($offset -ge 0) { $css = $css.Substring(0, $offset) }
    $css += $cssMarker + "`n" + (Get-WorkbenchStyle)
    [IO.File]::WriteAllText($cssPath, $css, [Text.UTF8Encoding]::new($false))
    Set-CoreChecksum $Product 'vs/workbench/workbench.desktop.main.css'
    Set-StartupHtml (Join-Path $AppRoot 'out/vs/code/electron-browser/workbench/workbench.html')
    Set-CoreChecksum $Product 'vs/code/electron-browser/workbench/workbench.html'
}

function Set-BackgroundTrayCore {
    $mainPath = Join-Path $AppRoot 'out/main.js'
    $main = [IO.File]::ReadAllText($mainPath)
    $anchor = 'i.add(k.fromNodeEventEmitter(s,"close")(r=>{const n=e.id;this.windowToCloseRequest.delete(n)||('
    $replacement = 'i.add(k.fromNodeEventEmitter(s,"close")(r=>{s.emit("ubovm-before-close",r,this._quitRequested);if(r.defaultPrevented)return;const n=e.id;this.windowToCloseRequest.delete(n)||('
    if (-not $main.Contains($replacement)) {
        $main = Replace-CoreSnippet $main $anchor $replacement
        [IO.File]::WriteAllText($mainPath, $main, [Text.UTF8Encoding]::new($false))
    }
}

function Sync-Application {
    Sync-Harness (Join-Path $AppRoot 'ubovm')
    Set-ProductBranding $AppRoot
    $productPath = Join-Path $AppRoot 'product.json'
    $basePath = Join-Path $AppRoot 'product.ubovm-base.json'
    if (-not (Test-Path -LiteralPath $basePath)) { Copy-Item -LiteralPath $productPath -Destination $basePath }
    $product = Get-Content -LiteralPath $basePath -Raw | ConvertFrom-Json
    foreach ($property in $Config.product.PSObject.Properties) {
        if ($property.Name -eq 'extensionEnabledApiProposals') {
            # Merge UBOVM proposals into the runtime map; do not replace other extensions.
            if (-not $product.extensionEnabledApiProposals) {
                $product | Add-Member -NotePropertyName extensionEnabledApiProposals -NotePropertyValue ([pscustomobject]@{}) -Force
            }
            foreach ($proposal in $property.Value.PSObject.Properties) {
                $product.extensionEnabledApiProposals | Add-Member -NotePropertyName $proposal.Name -NotePropertyValue $proposal.Value -Force
            }
            continue
        }
        $product | Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value -Force
    }
    Set-FixedConversationCore $product
    Set-BackgroundTrayCore
    Write-Json $productPath $product
    $mainDirectory = Join-Path $AppRoot 'ubovm/main'
    New-Item -ItemType Directory -Force -Path $mainDirectory | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'src/main') -Filter '*.mjs' -File | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $mainDirectory $_.Name) -Force
    }
    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'resources/app.json') -Destination (Join-Path $AppRoot 'ubovm/app.json') -Force
    $manifestPath = Join-Path $AppRoot 'package.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $manifest.main = './ubovm/main/index.mjs'
    Write-Json $manifestPath $manifest
    $extensionsRoot = Join-Path $AppRoot 'extensions'
    $extension = Join-Path $extensionsRoot 'ubovm-core'
    Remove-Managed $extension $extensionsRoot
    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'src/renderer') -Destination $extension -Recurse
    $npmManifestPath = Join-Path $extensionsRoot 'npm\package.json'
    $npmManifest = Get-Content -LiteralPath $npmManifestPath -Raw | ConvertFrom-Json
    foreach ($view in $npmManifest.contributes.views.explorer) {
        if ($view.id -eq 'npm') { $view.when = 'false' }
    }
    Write-Json $npmManifestPath $npmManifest
}

function Initialize-Runtime {
    Assert-ChildPath $Runtime $RuntimeRoot
    if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
        throw 'This runtime requires Windows x64.'
    }
    $marker = Join-Path $Runtime '.ubovm-installed.json'
    if (-not (Test-Path -LiteralPath $marker)) {
        if (Test-Path -LiteralPath $Runtime) { throw "Incomplete runtime. Move it aside before retrying: $Runtime" }
        $cache = Join-Path $ProjectRoot '.cache'
        New-Item -ItemType Directory -Force -Path $cache, $RuntimeRoot | Out-Null
        $archive = Join-Path $cache $Config.core.runtime.archive
        Assert-ChildPath $archive $cache
        if (-not (Test-Path -LiteralPath $archive)) {
            Write-Host '[UBOVM] Downloading the pinned Code OSS desktop runtime...'
            Invoke-ArchiveDownload (Get-RuntimeDownloadUrls) $archive $Config.core.runtime.sha256
        }
        Write-Host '[UBOVM] Verifying SHA-256...'
        Assert-Archive $archive
        $staging = Join-Path $RuntimeRoot ('.staging-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $staging | Out-Null
        try {
            Write-Host '[UBOVM] Extracting Electron and the workbench...'
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            [IO.Compression.ZipFile]::ExtractToDirectory($archive, $staging)
            $manifest = Get-Content -LiteralPath (Join-Path $staging 'resources/app/package.json') -Raw | ConvertFrom-Json
            if ($manifest.version -ne $Config.core.runtime.version) { throw "Unexpected runtime version: $($manifest.version)" }
            if (-not (Test-Path -LiteralPath (Join-Path $staging $Config.core.runtime.executable))) { throw 'Archive contains no desktop executable.' }
            Write-Json (Join-Path $staging '.ubovm-installed.json') $Config.core.runtime
            Assert-ChildPath $staging $RuntimeRoot
            Assert-ChildPath $Runtime $RuntimeRoot
            Move-Item -LiteralPath $staging -Destination $Runtime
        } finally { Remove-Managed $staging $RuntimeRoot }
    }
    $installed = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    if ($installed.sha256 -ne $Config.core.runtime.sha256 -or -not (Test-Path -LiteralPath $Executable)) {
        throw 'The installed runtime does not match resources/app.json.'
    }
    Sync-Application
    Write-Host "[UBOVM] Ready: VS Code $($Config.core.source.ref) / VSCodium $($Config.core.runtime.version)"
}

function Get-InstallerTools {
    $toolsRoot = Join-Path $ProjectRoot '.cache/installer-tools'
    $cachedCompiler = Join-Path $toolsRoot 'node_modules/innosetup/bin/ISCC.exe'
    $cachedEditor = Join-Path $toolsRoot 'node_modules/rcedit/bin/rcedit.exe'
    if ($env:UBOVM_ISCC -and -not (Test-Path -LiteralPath $env:UBOVM_ISCC -PathType Leaf)) {
        throw "UBOVM_ISCC must point to an existing ISCC.exe file: $env:UBOVM_ISCC"
    }
    $candidates = @($env:UBOVM_ISCC, (Join-Path $ProjectRoot 'vendor/vscode/node_modules/innosetup/bin/ISCC.exe'))
    foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)) {
        if ($base) { $candidates += Join-Path $base 'Inno Setup 6/ISCC.exe'; $candidates += Join-Path $base 'Programs/Inno Setup 6/ISCC.exe' }
    }
    $compiler = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
    if (-not $compiler) { $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue; if ($command) { $compiler = $command.Source } }
    if (-not $compiler -and (Test-Path -LiteralPath $cachedCompiler -PathType Leaf)) { $compiler = $cachedCompiler }
    $editor = Join-Path $ProjectRoot 'vendor/vscode/node_modules/rcedit/bin/rcedit.exe'
    if (-not (Test-Path -LiteralPath $editor -PathType Leaf)) { $editor = $cachedEditor }
    if (-not $compiler -or -not (Test-Path -LiteralPath $editor -PathType Leaf)) {
        New-Item -ItemType Directory -Force -Path $toolsRoot | Out-Null
        $installer = Get-HarnessInstaller
        $oldPath = $env:PATH
        try {
            $env:PATH = (Split-Path -Parent $installer.Node) + [IO.Path]::PathSeparator + $oldPath
            Write-Host '[UBOVM] Preparing cached Inno Setup and executable branding tools...'
            Invoke-Checked $installer.Npm @('install', '--prefix', $toolsRoot, '--no-save', '--package-lock=false', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', (Join-Path $ProjectRoot '.cache/npm'), 'innosetup@6.4.1', 'rcedit@1.1.0') $toolsRoot
        } finally { $env:PATH = $oldPath }
        if (-not $compiler) { $compiler = $cachedCompiler }
    }
    foreach ($tool in @($compiler, $editor)) {
        if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw "Installer tool preparation did not produce: $tool" }
    }
    return @{ Compiler = $compiler; Editor = $editor }
}

function Invoke-InstallerCompiler($Compiler, $Arguments, $Staging) {
    if (-not (Test-Path -LiteralPath $Compiler -PathType Leaf)) { throw "Installer compiler not found: $Compiler" }
    $previousTemp = $env:TEMP
    $previousTmp = $env:TMP
    $previousPreference = $ErrorActionPreference
    $attemptRoot = Join-Path $Staging ('compile-' + [Guid]::NewGuid().ToString('N'))
    Assert-ChildPath $attemptRoot $Staging
    New-Item -ItemType Directory -Force -Path $attemptRoot | Out-Null
    try {
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            $temporary = Join-Path $attemptRoot "temp-$attempt"
            New-Item -ItemType Directory -Path $temporary | Out-Null
            $env:TEMP = $temporary
            $env:TMP = $temporary
            $log = Join-Path $attemptRoot "iscc-$attempt.log"
            # Windows PowerShell may wrap native stderr in ErrorRecord objects.
            # Read the native exit code and retain diagnostics before deciding to retry.
            $ErrorActionPreference = 'Continue'
            $global:LASTEXITCODE = $null
            & $Compiler @Arguments 2>&1 | Tee-Object -FilePath $log | ForEach-Object { Write-Host $_ }
            $compilerExit = $LASTEXITCODE
            $ErrorActionPreference = $previousPreference
            if ($null -eq $compilerExit) { throw "Installer compiler could not start. Diagnostics: $log" }
            if ($compilerExit -eq 0) { return }
            $diagnostics = Get-Content -LiteralPath $log -Raw
            $resourceAccessFailure = $diagnostics -match '(?i)(?:Begin|End)UpdateResource(?:\w*)? failed\s*\((?:5|32|33|110)\)'
            if (-not $resourceAccessFailure -or $attempt -eq 3) {
                throw "Installer compiler exited with $compilerExit. Diagnostics: $log"
            }
            Write-Host "[UBOVM] Resource update could not access its temporary executable; retrying ($attempt/3). Log: $log"
            Start-Sleep -Seconds $attempt
        }
    } finally {
        $env:TEMP = $previousTemp
        $env:TMP = $previousTmp
        $ErrorActionPreference = $previousPreference
    }
}

function Build-Installer {
    if (-not $UsePrebuilt) { throw 'The installer target currently supports Windows x64 only.' }
    $tools = Get-InstallerTools
    $compiler = $tools.Compiler
    $editor = $tools.Editor
    $manifest = Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json
    $version = $manifest.version
    if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Installer requires a numeric major.minor.patch version in package.json.' }
    Initialize-Runtime
    Test-Runtime
    $staging = Join-Path $ProjectRoot '.cache/installer'
    $payload = Join-Path $staging 'UBOVM-win32-x64'
    $output = Join-Path $ProjectRoot 'dist'
    New-Item -ItemType Directory -Force -Path $staging, $output | Out-Null
    Remove-Managed $payload $staging
    New-Item -ItemType Directory -Path $payload | Out-Null
    Write-Host '[UBOVM] Staging standalone application (excluding portable user data)...'
    & robocopy.exe $Runtime $payload /E /XJ /R:1 /W:1 /NFL /NDL /NJH /NJS /NP /XD (Join-Path $Runtime 'data') /XF '.ubovm-installed.json'
    if ($LASTEXITCODE -ge 8) { throw "Payload copy failed with robocopy exit code $LASTEXITCODE" }
    $originalExe = Join-Path $payload $Config.core.runtime.executable
    $appExe = Join-Path $payload 'UBOVM.exe'
    Assert-ChildPath $originalExe $payload
    Assert-ChildPath $appExe $payload
    if ($originalExe -ne $appExe) { Move-Item -LiteralPath $originalExe -Destination $appExe }
    $icon = Join-Path $ProjectRoot 'src/renderer/media/app-icon.ico'
    Invoke-Checked $editor @($appExe, '--set-icon', $icon, '--set-version-string', 'ProductName', 'UBOVM IDE',
        '--set-version-string', 'FileDescription', 'UBOVM IDE', '--set-version-string', 'CompanyName', 'UBOVM',
        '--set-version-string', 'OriginalFilename', 'UBOVM.exe', '--set-file-version', $version, '--set-product-version', $version)
    $bin = Join-Path $payload 'bin'
    Remove-Managed $bin $payload
    New-Item -ItemType Directory -Path $bin | Out-Null
    [IO.File]::WriteAllText((Join-Path $bin 'ubovm.cmd'), "@echo off`r`nsetlocal`r`nset ELECTRON_RUN_AS_NODE=1`r`n`"%~dp0..\UBOVM.exe`" `"%~dp0..\resources\app\out\cli.js`" %*`r`n", [Text.Encoding]::ASCII)
    $oldVisual = Join-Path $payload (([IO.Path]::GetFileNameWithoutExtension($Config.core.runtime.executable)) + '.VisualElementsManifest.xml')
    if (Test-Path -LiteralPath $oldVisual) { Move-Item -LiteralPath $oldVisual -Destination (Join-Path $payload 'UBOVM.VisualElementsManifest.xml') }
    $packagedExtension = Join-Path $payload 'resources/app/extensions/ubovm-core'
    Remove-Managed (Join-Path $packagedExtension 'test') $packagedExtension
    $chinese = Join-Path $ProjectRoot 'vendor/vscode/build/win32/i18n/Default.zh-cn.isl'
    if (-not (Test-Path -LiteralPath $chinese)) { throw 'Missing installer Chinese translation; run node build.mjs source fetch.' }
    Invoke-InstallerCompiler $compiler @('/Qp', "/DAppVersion=$version", "/DPayloadDir=$payload", "/DOutputDir=$output", "/DAppIcon=$icon", "/DChineseMessages=$chinese", (Join-Path $ProjectRoot 'resources/installer/ubovm.iss')) $staging
    $result = Join-Path $output "UBOVM-Setup-$version-x64.exe"
    if (-not (Test-Path -LiteralPath $result)) { throw 'Installer compiler did not produce the expected executable.' }
    [IO.File]::WriteAllText(($result + '.sha256'), (Get-FileDigest $result) + '  ' + [IO.Path]::GetFileName($result) + "`n", [Text.Encoding]::ASCII)
    Write-Host "[UBOVM] Installer ready: $result"
}

function Quote-NativeArgument([string]$Value) {
    # Preserve spaces, quotes and trailing backslashes for Windows argv parsing.
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    return '"' + [regex]::Replace($escaped, '(\\+)$', '$1$1') + '"'
}

function Start-Desktop([switch]$Development, [switch]$Smoke) {
    Initialize-Runtime
    $portable = Set-PortableData $(if ($Smoke) { 'smoke' } else { 'desktop' })
    $env:UBOVM_HARNESS_ENTRY = Join-Path $AppRoot 'ubovm/harness/index.mjs'
    $arguments = @('--skip-welcome', '--skip-release-notes')
    # Ordinary launches reuse Code OSS's existing window and IPC owner.
    # Tests require their own window; development uses upstream host matching.
    if ($Smoke) { $arguments += '--new-window' }
    elseif (-not $Development) { $arguments += '--reuse-window' }
    if ($Development) { $arguments += '--extensionDevelopmentPath=' + (Join-Path $ProjectRoot 'src/renderer') }
    if ($Smoke) {
        $workspace = Join-Path $ProjectRoot '.cache/smoke-workspace'
        New-Item -ItemType Directory -Force -Path $workspace | Out-Null
        $result = Join-Path $workspace 'result.json'
        if (Test-Path -LiteralPath $result) { Remove-Item -LiteralPath $result }
        [IO.File]::WriteAllText((Join-Path $workspace 'README.md'), '# UBOVM smoke workspace')
        # A separate test harness ensures UBOVM is tested as a real built-in,
        # instead of silently replacing it with its development directory.
        $harness = Join-Path $workspace 'harness'
        New-Item -ItemType Directory -Force -Path $harness | Out-Null
        Write-Json (Join-Path $harness 'package.json') @{ name = 'smoke-harness'; publisher = 'ubovm'; version = '0.0.1'; engines = @{ vscode = '^1.100.0' } }
        $arguments += '--extensionDevelopmentPath=' + $harness
        $env:UBOVM_SMOKE_WORKSPACE = $workspace
        $env:UBOVM_SMOKE_RESULT = $result
        $arguments += '--disable-workspace-trust'
        $arguments += '--extensionTestsPath=' + (Join-Path $ProjectRoot 'src/renderer/test/desktop/smoke.cjs')
    } else {
        $workspace = if ($env:UBOVM_ARGUMENT) { [IO.Path]::GetFullPath($env:UBOVM_ARGUMENT) } else { $ProjectRoot }
        if (-not (Test-Path -LiteralPath $workspace -PathType Container)) { throw "Workspace folder not found: $workspace" }
    }
    $arguments += $workspace
    $quoted = ($arguments | ForEach-Object { Quote-NativeArgument $_ }) -join ' '
    $log = Join-Path $portable ('user-data/logs/launcher-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
    # This is the visible IDE requested by the user, not a background helper.
    $windowStyle = if ($Smoke) { 'Hidden' } else { 'Normal' }
    $desktop = Start-Process -FilePath $Executable -ArgumentList $quoted -WorkingDirectory $ProjectRoot -WindowStyle $windowStyle -PassThru -RedirectStandardOutput ($log + '.out.log') -RedirectStandardError ($log + '.err.log')
    if ($Smoke) {
        if (-not $desktop.WaitForExit(120000)) {
            & taskkill.exe /PID $desktop.Id /T /F | Out-Null
            throw 'Desktop integration test timed out (120s).'
        }
        $desktop.Refresh()
        if (-not (Test-Path -LiteralPath $result)) {
            Get-Content -LiteralPath ($log + '.err.log') -Tail 20 -ErrorAction SilentlyContinue
            throw "The extension host did not produce a result. Logs: $log"
        }
        $report = Get-Content -LiteralPath $result -Raw | ConvertFrom-Json
        foreach ($check in $report.checks) { Write-Host "[$($check.ok)] $($check.name)" }
        if ($report.ok -ne $true -or ($null -ne $desktop.ExitCode -and $desktop.ExitCode -ne 0)) { throw "Desktop integration test failed. Report: $result" }
        Write-Host "[UBOVM] Desktop integration test passed: $result"
    } else {
        Write-Host "[UBOVM] Desktop launched (PID $($desktop.Id)). Data: $portable"
    }
}

function Test-Runtime {
    if (-not (Test-Path -LiteralPath (Join-Path $AppRoot 'ubovm/main/launch-policy.mjs'))) { throw 'Missing launch policy. Run node build.mjs setup.' }
    if (-not (Test-Path -LiteralPath (Join-Path $AppRoot 'ubovm/main/background.mjs'))) { throw 'Missing background mode. Run node build.mjs setup.' }
    $files = @('ubovm/main/index.mjs', 'ubovm/main/data-paths.mjs', 'ubovm/main/data-migration.mjs', 'ubovm/harness/index.mjs', 'ubovm/harness/blackboard/database/database.mjs', 'ubovm/node_modules/@earendil-works/pi-agent-core/package.json', 'ubovm/node_modules/@modelcontextprotocol/sdk/package.json', 'ubovm/node_modules/yaml/package.json', 'out/main.js', 'out/vs/workbench/workbench.desktop.main.js', 'out/vs/workbench/api/node/extensionHostProcess.js', 'extensions/ubovm-core/extension.cjs')
    $files += @('extensions/ubovm-core/harness/workspace/workspace-search.cjs', 'extensions/ubovm-core/harness/workspace/workspace-validation.cjs', 'extensions/ubovm-core/harness/workspace/validation-worker.cjs', 'extensions/node_modules/typescript/lib/typescript.js', 'node_modules.asar.unpacked\@vscode\ripgrep-universal\bin\win32-x64\rg.exe')
    $files += @('ubovm/runtime/python/python.exe', 'ubovm/runtime/python/.ubovm-python-runtime.json')
    $files += @('extensions/ubovm-core/host/agent/agent-service.cjs', 'extensions/ubovm-core/host/agent/agent-backend.cjs')
    $files += @('harness-service.cjs', 'harness-thread.cjs', 'thread-rpc.cjs', 'snapshot-queue.cjs', 'projection.cjs', 'errors.cjs') | ForEach-Object { 'ubovm/harness/ide/runtime/' + $_ }
    foreach ($file in $files) {
        if (-not (Test-Path -LiteralPath (Join-Path $AppRoot $file))) { throw "Missing $file. Run node build.mjs setup." }
        Write-Host "[OK] $file"
    }
    $manifest = Get-Content -LiteralPath (Join-Path $AppRoot 'package.json') -Raw | ConvertFrom-Json
    if ($manifest.main -ne './ubovm/main/index.mjs') { throw 'The custom Electron main entry is not connected.' }
    if (-not ([IO.File]::ReadAllText((Join-Path $AppRoot 'out/main.js'))).Contains('s.emit("ubovm-before-close",r,this._quitRequested)')) { throw 'The background lifecycle hook is missing. Run node build.mjs setup.' }
    $legacyKeys = (Get-PatchAdditions (Join-Path $ProjectRoot 'resources/patches/keyboard-policy.patch') 'src/vs/platform/keybinding/common/abstractKeybindingService.ts').Replace('resolveResult.commandId', 'l.commandId')
    $searchKeys = Get-PatchAdditions (Join-Path $ProjectRoot 'resources/patches/file-search.patch') 'src/vs/platform/keybinding/common/abstractKeybindingService.ts'
    $currentKeys = [regex]::Replace($legacyKeys, '(?m)^.*if \(/\^\(\?:workbench.*\{\r?$', $searchKeys.TrimEnd())
    Assert-CurrentKeyboardPolicy ([IO.File]::ReadAllText((Join-Path $AppRoot 'out/vs/workbench/workbench.desktop.main.js'))) $legacyKeys $currentKeys
    Write-Host '[OK] Runtime keyboard policy matches source'
    Write-Host "[OK] Electron entry connected; runtime $($manifest.version)"
}

function Invoke-Core {
    param([ValidateSet('fetch', 'doctor', 'apply', 'install', 'ensure-install', 'build', 'watch', 'start')][string]$Action)
    if ($Action -notin @('fetch', 'apply', 'install', 'ensure-install', 'build') -or $script:SourceMutationLock) {
        Invoke-CoreUnlocked $Action
        return
    }
    $cache = Join-Path $ProjectRoot '.cache'
    New-Item -ItemType Directory -Force -Path $cache | Out-Null
    $lockPath = Join-Path $cache 'source-mutation.lock'
    try {
        $script:SourceMutationLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch {
        throw "Cannot acquire source operation lock ($lockPath). Another source operation may be running. $($_.Exception.Message)"
    }
    try { Invoke-CoreUnlocked $Action }
    finally {
        $script:SourceMutationLock.Dispose()
        $script:SourceMutationLock = $null
    }
}

function Invoke-CoreUnlocked {
    param([ValidateSet('fetch', 'doctor', 'apply', 'install', 'ensure-install', 'build', 'watch', 'start')][string]$Action)
    $Pin = $Config.core.source
    $SourceRoot = Join-Path $ProjectRoot 'vendor/vscode'
    if (!$Pin.repository -or !$Pin.ref -or $Pin.commit -notmatch '^[a-fA-F0-9]{40}$' -or !$Pin.node) {
        throw 'Configuration needs core.source.repository, ref, commit (40 hex digits), and node.'
    }
    $VerifySource = {
        if (!(Test-Path -LiteralPath (Join-Path $SourceRoot '.git'))) { throw 'Source missing: run node build.mjs source fetch.' }
        $Top = & git -c "safe.directory=$SourceRoot" -C $SourceRoot rev-parse --show-toplevel
        if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath($Top.Trim()) -ne $SourceRoot) { throw 'vendor/vscode must be its own Git checkout.' }
        $Head = & git -c "safe.directory=$SourceRoot" -C $SourceRoot rev-parse HEAD
        if ($LASTEXITCODE -ne 0 -or $Head.Trim() -ne $Pin.commit) {
            throw "Source commit differs from pin $($Pin.commit). Existing checkout was left untouched; reconcile it before continuing."
        }
    }
    switch ($Action) {
        'doctor' {
            $Missing = [Collections.Generic.List[string]]::new()
            try {
                $Node = Get-Command node -ErrorAction Stop
                $Version = [version]((& $Node.Source --version).Trim() -replace '^v', '')
                $Required = [version]$Pin.node
                if ($Version.Major -ne $Required.Major -or $Version -lt $Required) { throw 'unsupported version' }
                Write-Host "[OK] Node $Version"
            } catch { $Missing.Add("Node $($Pin.node) or newer within the same major version") }
            if (!(Get-Command git -ErrorAction SilentlyContinue)) { $Missing.Add('Git on PATH') }
            if (!(Get-Command $NpmCommand -ErrorAction SilentlyContinue)) { $Missing.Add("$NpmCommand on PATH") }
            $Python = $null
            $Candidates = @($env:npm_config_python, $env:PYTHON, 'py', 'python', 'python3') | Where-Object { $_ }
            foreach ($Name in $Candidates) {
                try {
                    $Executable = Get-Command $Name -ErrorAction Stop
                    $Probe = @('-c', 'import sys; assert sys.version_info.major == 3; print(sys.executable)')
                    if ($Name -eq 'py') { $Probe = @('-3') + $Probe }
                    $Found = & $Executable.Source @Probe 2>$null
                    if ($LASTEXITCODE -eq 0 -and $Found -and (Test-Path -LiteralPath $Found.Trim())) { $Python = $Found.Trim(); break }
                } catch { }
            }
            if ($Python) { $env:npm_config_python = $Python; Write-Host "[OK] Python 3: $Python" }
            else { $Missing.Add('Python 3 on PATH (or npm_config_python pointing to python.exe)') }
            if ($OnWindows) {
            $VSWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
            $VS = $null
            if (Test-Path -LiteralPath $VSWhere) {
                # Decode vswhere's UTF-8 bytes explicitly. Windows PowerShell otherwise
                # uses the console code page, which can corrupt localized JSON strings.
                $VSStartInfo = [Diagnostics.ProcessStartInfo]::new($VSWhere, '-latest -products * -version [16.0,18.0) -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -format json -utf8')
                $VSStartInfo.UseShellExecute = $false
                $VSStartInfo.CreateNoWindow = $true
                $VSStartInfo.RedirectStandardOutput = $true
                $VSStartInfo.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
                $VSProcess = [Diagnostics.Process]::Start($VSStartInfo)
                try {
                    $Instances = $VSProcess.StandardOutput.ReadToEnd()
                    $VSProcess.WaitForExit()
                    if ($VSProcess.ExitCode -eq 0) { $VS = $Instances | ConvertFrom-Json | Select-Object -First 1 }
                } finally { $VSProcess.Dispose() }
            }
            if ($VS) {
                $VSYear = if ($VS.installationVersion.StartsWith('17.')) { '2022' } else { '2019' }
                [Environment]::SetEnvironmentVariable("vs${VSYear}_install", $VS.installationPath, 'Process')
                Write-Host "[OK] Visual Studio $VSYear C++: $($VS.installationPath)"
            } else { $Missing.Add('Visual Studio 2022 C++ Build Tools, MSVC v143, Spectre libraries, and Windows SDK (detected with vswhere)') }
            } else {
                foreach ($tool in @('bash', 'make', 'pkg-config')) {
                    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { $Missing.Add("$tool on PATH") }
                }
                $compiler = if ($OnMac) { 'clang++' } else { 'g++' }
                if (-not (Get-Command $compiler -ErrorAction SilentlyContinue)) { $Missing.Add("$compiler on PATH") }
                if ($OnMac) {
                    try { Invoke-Checked '/usr/bin/xcode-select' @('-p') } catch { $Missing.Add('Xcode Command Line Tools') }
                }
            }
            if ($Missing.Count) { throw ("Missing source prerequisites:`n - " + ($Missing -join "`n - ")) }
            Write-Host 'Prerequisites found. Upstream npm ci performs the complete native build checks.'
        }
        'fetch' {
            if (!(Test-Path -LiteralPath $SourceRoot)) {
                New-Item -ItemType Directory -Path (Split-Path $SourceRoot) -Force | Out-Null
                Invoke-Checked (Get-Command git -ErrorAction Stop).Source @('-c', 'core.longpaths=true', 'clone', '--depth', '1', '--single-branch', '--branch', $Pin.ref, '--', $Pin.repository, $SourceRoot) $ProjectRoot
            }
            & $VerifySource
            Write-Host "Verified Code - OSS $($Pin.ref) at $($Pin.commit); local changes are preserved."
        }
        'apply' {
            & $VerifySource
            if (!$Config.product) { throw 'Configuration needs product overrides.' }
            $PatchNames = @(Get-SourcePatchNames)
            if (Update-LegacySidebarCloseTabsPatch $SourceRoot) {
                Write-Host '[OK] Upgraded legacy sidebar-close-tabs.patch with Delete autorepeat guard'
            }
            if (Update-LegacySidebarModePatch $SourceRoot) {
                Write-Host '[OK] Upgraded legacy sidebar-mode.patch with component loading guards'
            }
            $AppliedPatches = Get-AppliedSourcePatches $SourceRoot $PatchNames
            foreach ($PatchName in $PatchNames) {
            $Patch = Join-Path $ProjectRoot ('resources/patches/' + $PatchName)
            $AlreadyApplied = $AppliedPatches.Contains($PatchName)
            if ($AlreadyApplied) {
                Write-Host "[OK] Source $PatchName already applied"
            } elseif ($PatchName -eq 'minimal-ui.patch' -and (Update-LegacyMinimalUiPatch $SourceRoot $Patch)) {
                Write-Host "[OK] Upgraded legacy $PatchName with coding commands"
            } else {
                Invoke-Checked (Get-Command git).Source @('-c', "safe.directory=$SourceRoot", '-C', $SourceRoot, 'apply', '--check', $Patch)
                Invoke-Checked (Get-Command git).Source @('-c', "safe.directory=$SourceRoot", '-C', $SourceRoot, 'apply', $Patch)
                Write-Host "[OK] Applied source $PatchName"
            }
            }
            $SourceCss = Join-Path $SourceRoot 'src/vs/workbench/browser/media/style.css'
            $Css = [IO.File]::ReadAllText($SourceCss)
            $CssMarker = '/* UBOVM COMPACT WORKBENCH */'
            $Offset = $Css.IndexOf($CssMarker)
            if ($Offset -ge 0) { $Css = $Css.Substring(0, $Offset) }
            $Css += $CssMarker + "`n" + (Get-WorkbenchStyle)
            Set-ProductBranding $SourceRoot
            [IO.File]::WriteAllText($SourceCss, $Css, [Text.UTF8Encoding]::new($false))
            Set-StartupHtml (Join-Path $SourceRoot 'src/vs/code/electron-browser/workbench/workbench.html')
            Set-StartupHtml (Join-Path $SourceRoot 'src/vs/code/electron-browser/workbench/workbench-dev.html')
            $Destination = Join-Path $SourceRoot 'product.overrides.json'
            $Overrides = [ordered]@{}
            if (Test-Path -LiteralPath $Destination) {
                $Existing = Get-Content -LiteralPath $Destination -Raw | ConvertFrom-Json
                foreach ($Property in $Existing.PSObject.Properties) { $Overrides[$Property.Name] = $Property.Value }
            }
            foreach ($Property in $Config.product.PSObject.Properties) { $Overrides[$Property.Name] = $Property.Value }
            [IO.File]::WriteAllText($Destination, (($Overrides | ConvertTo-Json -Depth 100) + "`n"), [Text.UTF8Encoding]::new($false))
            # Source and prebuilt desktops share the same main entry and data policy.
            $mainDirectory = Join-Path $SourceRoot 'ubovm/main'
            New-Item -ItemType Directory -Force -Path $mainDirectory | Out-Null
            Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'src/main') -Filter '*.mjs' -File | ForEach-Object {
                Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $mainDirectory $_.Name) -Force
            }
            Copy-Item -LiteralPath (Join-Path $ProjectRoot 'resources/app.json') -Destination (Join-Path $SourceRoot 'ubovm/app.json') -Force
            $manifestPath = Join-Path $SourceRoot 'package.json'
            $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
            $manifest.main = './ubovm/main/index.mjs'
            Write-Json $manifestPath $manifest
            Write-Host 'Applied source product.overrides.json (loaded by upstream VSCODE_DEV).'
        }
        'ensure-install' {
            # Check again while holding the lock: another process may have installed.
            if (!(Test-SourceInstallState $SourceRoot)) { Invoke-Core install }
        }
        'install' {
            Invoke-Core doctor
            Invoke-Core fetch
            Invoke-Checked (Get-Command node -ErrorAction Stop).Source @((Join-Path $ProjectRoot 'src/main/source-dependencies.mjs'), $SourceRoot) $ProjectRoot
            # Installation fixes must be applied before upstream postinstall runs.
            Invoke-Core apply
            $OldForce = $env:VSCODE_FORCE_INSTALL; $OldIgnore = $env:npm_config_ignore_scripts; $OldSkip = $env:VSCODE_SKIP_NODE_VERSION_CHECK
            try {
                $env:VSCODE_FORCE_INSTALL = '1'; $env:npm_config_ignore_scripts = 'false'; $env:VSCODE_SKIP_NODE_VERSION_CHECK = $null
                Invoke-Checked (Get-Command $NpmCommand -ErrorAction Stop).Source @('ci', '--ignore-scripts=false') $SourceRoot
            } finally { $env:VSCODE_FORCE_INSTALL = $OldForce; $env:npm_config_ignore_scripts = $OldIgnore; $env:VSCODE_SKIP_NODE_VERSION_CHECK = $OldSkip }
            Invoke-Core apply
        }
        { $_ -in 'build', 'watch' } {
            & $VerifySource
            Invoke-Core apply
            Invoke-Core ensure-install
            $Script = if ($Action -eq 'build') { 'compile' } else { 'watch' }
            Invoke-Checked (Get-Command $NpmCommand -ErrorAction Stop).Source @('run', $Script) $SourceRoot
        }
        'start' {
            & $VerifySource
            if (!(Test-Path -LiteralPath (Join-Path $SourceRoot 'out/main.js')) -or !(Test-Path -LiteralPath (Join-Path $SourceRoot 'out/vs/workbench/workbench.desktop.main.js'))) { throw 'Run node build.mjs source build, or wait for source watch to finish its first compilation.' }
            if ($OnWindows -and $ProjectRoot -match '[\x00-\x1f"&|<>^%!()]') { throw 'The upstream Windows batch launcher needs a project path without shell metacharacters.' }
            Invoke-Core apply
            Invoke-Core ensure-install
            $OldPortable = $env:VSCODE_PORTABLE; $OldSkip = $env:VSCODE_SKIP_PRELAUNCH; $OldNode = $env:ELECTRON_RUN_AS_NODE; $OldHarness = $env:UBOVM_HARNESS_ENTRY
            try {
                $Portable = Set-PortableData $(if ($env:UBOVM_SOURCE_SMOKE -eq '1') { 'smoke' } elseif ($env:UBOVM_SOURCE_DESKTOP -eq '1') { 'desktop' } else { 'source' })
                # The source extension resolves its SDK through the same
                # standalone package as the prebuilt desktop.
                $harnessRuntime = Join-Path $ProjectRoot '.cache/source-harness'
                Sync-Harness $harnessRuntime
                $env:UBOVM_HARNESS_ENTRY = Join-Path $harnessRuntime 'harness/index.mjs'
                $env:VSCODE_SKIP_PRELAUNCH = $null; $env:ELECTRON_RUN_AS_NODE = $null
                $workspace = if ($env:UBOVM_SOURCE_WORKSPACE) { [IO.Path]::GetFullPath($env:UBOVM_SOURCE_WORKSPACE) } else { $ProjectRoot }
                if (-not (Test-Path -LiteralPath $workspace -PathType Container)) { throw "Workspace folder not found: $workspace" }
                $LaunchArgs = @($workspace, '--new-window', "--extensionDevelopmentPath=$(Join-Path $ProjectRoot 'src/renderer')", "--user-data-dir=$(Join-Path $Portable 'user-data')", "--extensions-dir=$(Join-Path $Portable 'extensions')", "--shared-data-dir=$(Join-Path $Portable 'shared-data')", "--crash-reporter-directory=$(Join-Path $Portable 'crashes')")
                if ($env:UBOVM_SOURCE_SMOKE -eq '1') {
                    # Prepare Electron before starting the bounded desktop test.
                    Invoke-Checked (Get-Command $NodeCommand).Source @('build/lib/preLaunch.ts') $SourceRoot
                    $env:VSCODE_SKIP_PRELAUNCH = '1'
                    $LaunchArgs += @('--disable-workspace-trust', "--extensionTestsPath=$(Join-Path $ProjectRoot 'src/renderer/test/desktop/smoke.cjs')")
                }
                if ($OnWindows) {
                    Invoke-Checked (Join-Path $SourceRoot 'scripts/code.bat') $LaunchArgs $SourceRoot
                } else {
                    $timeout = if ($env:UBOVM_SOURCE_SMOKE -eq '1') { 120000 } else { 0 }
                    Invoke-Checked (Get-Command bash -ErrorAction Stop).Source (@('scripts/code.sh') + $LaunchArgs) $SourceRoot $timeout
                }
            } finally { $env:VSCODE_PORTABLE = $OldPortable; $env:VSCODE_SKIP_PRELAUNCH = $OldSkip; $env:ELECTRON_RUN_AS_NODE = $OldNode; $env:UBOVM_HARNESS_ENTRY = $OldHarness }
        }
    }
}

function Test-SourceInstallState($SourceRoot) {
    & (Get-Command node -ErrorAction Stop).Source (Join-Path $ProjectRoot 'src/main/source-dependencies.mjs') $SourceRoot '--check-state'
    $stateExit = $LASTEXITCODE
    if ($stateExit -notin @(0, 1)) { throw 'Source dependency state check failed; repair the reported source inputs before continuing.' }
    if ($stateExit -ne 0) { Write-Host '[UBOVM] Source dependency cache is stale or incomplete; installing dependencies.' }
    return $stateExit -eq 0
}

function Test-SourceRuntime {
    Invoke-Core doctor
    foreach ($file in @('out/main.js', 'out/vs/workbench/workbench.desktop.main.js', 'out/vs/workbench/api/node/extensionHostProcess.js', 'product.overrides.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path (Join-Path $ProjectRoot 'vendor/vscode') $file))) { throw "Missing $file. Run npm run setup first." }
    }
    Write-Host '[OK] Compiled source runtime found.'
}

function Start-SourceDesktop([switch]$Smoke) {
    $source = Join-Path $ProjectRoot 'vendor/vscode'
    if (-not (Test-Path -LiteralPath (Join-Path $source 'out/vs/workbench/workbench.desktop.main.js'))) {
        Invoke-Core install
        Invoke-Core build
    }
    $env:UBOVM_SOURCE_DESKTOP = '1'
    $env:UBOVM_SOURCE_WORKSPACE = $env:UBOVM_ARGUMENT
    if ($Smoke) {
        $env:UBOVM_SOURCE_SMOKE = '1'
        $workspace = Join-Path $ProjectRoot '.cache/smoke-workspace'
        New-Item -ItemType Directory -Force -Path $workspace | Out-Null
        $result = Join-Path $workspace 'result.json'
        if (Test-Path -LiteralPath $result) { Remove-Item -LiteralPath $result }
        [IO.File]::WriteAllText((Join-Path $workspace 'README.md'), '# UBOVM smoke workspace')
        $env:UBOVM_SOURCE_WORKSPACE = $workspace
        $env:UBOVM_SMOKE_WORKSPACE = $workspace
        $env:UBOVM_SMOKE_RESULT = $result
    }
    Invoke-Core start
    if ($Smoke) {
        if (-not (Test-Path -LiteralPath $result)) { throw 'The extension host did not produce a smoke result.' }
        $report = Get-Content -LiteralPath $result -Raw | ConvertFrom-Json
        if ($report.ok -ne $true) { throw "Desktop integration test failed. Report: $result" }
        Write-Host "[OK] Desktop integration test passed: $result"
    }
}

try {
    switch ($Action.ToLowerInvariant()) {
        'build' {
            Write-Host '[UBOVM] Compiling the VS Code source (this does not launch the IDE).'
            Invoke-Core doctor
            Invoke-Core fetch
            Invoke-Core build
            Write-Host "[UBOVM] Compiled core: $(Join-Path $source 'out')"
            Write-Host '[UBOVM] Run it with: node build.mjs source start'
        }
        'start' { if ($UsePrebuilt) { Start-Desktop } else { Start-SourceDesktop } }
        'dev' { if ($UsePrebuilt) { Start-Desktop -Development } else { Start-SourceDesktop } }
        'setup' { if ($UsePrebuilt) { Initialize-Runtime } else { Invoke-Core install; Invoke-Core build } }
        'installer' { Build-Installer }
        'migrate' { $portable = Set-PortableData 'desktop'; Write-Host "[UBOVM] Persistent data ready: $portable" }
        'check' { if ($UsePrebuilt) { Test-Runtime } else { Test-SourceRuntime } }
        'test' { if ($UsePrebuilt) { Start-Desktop -Smoke } else { Start-SourceDesktop -Smoke } }
        'source' { Invoke-Core $env:UBOVM_ARGUMENT }
        'help' {
            Write-Host 'node build.mjs build            Check tools, install dependencies if needed, compile the VS Code source'
            Write-Host 'node build.mjs start [folder]   Start the desktop IDE'
            Write-Host 'node build.mjs dev [folder]     Load the UI extension from src/renderer'
            Write-Host 'node build.mjs setup            Download and prepare the runtime'
            Write-Host 'node build.mjs installer        Build a Windows x64 installer in dist'
            Write-Host 'node build.mjs migrate          Migrate desktop data to ~/.ubovm without launching'
            Write-Host 'node build.mjs check            Check the installed runtime'
            Write-Host 'node build.mjs test             Run a real desktop integration test'
            Write-Host 'node build.mjs source ACTION    fetch | doctor | install | apply | build | watch | start'
        }
        default { throw "Unknown action: $Action. Run node build.mjs help." }
    }
    exit 0
} catch {
    Write-Host ("[UBOVM] " + $_.Exception.Message) -ForegroundColor Red
    if ($env:UBOVM_DEBUG -eq '1') { Write-Host $_.Exception.ToString(); Write-Host $_.ScriptStackTrace }
    exit 1
}
