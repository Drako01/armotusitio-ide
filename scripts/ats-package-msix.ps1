# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root.
# Build a Store submission package from an immutable, hash-verified Windows release ZIP.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Archive,
    [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSha256,
    [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+\.0$')][string]$Version
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'MSIX packaging requires PowerShell 7 on Windows.' }
$packageVersion = [Version]::Parse($Version)
if ($packageVersion.Major -lt 1 -or $packageVersion.Major -gt 65535 -or $packageVersion.Minor -gt 65535 -or $packageVersion.Build -gt 65535) {
    throw 'Store package version components must be in range and the last component must be zero.'
}
$repoRoot = Split-Path $PSScriptRoot -Parent
$archiveFile = Get-Item -LiteralPath $Archive
if ($archiveFile.PSIsContainer -or ($archiveFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Archive must be a regular file.' }
$archiveHash = (Get-FileHash -LiteralPath $archiveFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
if ($archiveHash -ne $ExpectedSha256.ToLowerInvariant()) { throw 'Release archive SHA256 mismatch.' }
$sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
$sdkVersions = Get-ChildItem -LiteralPath $sdkRoot -Directory | Where-Object Name -Match '^10\.\d+\.\d+\.\d+$' | Sort-Object { [Version]$_.Name } -Descending
$makeAppx = $null
foreach ($sdkVersion in $sdkVersions) {
    $candidate = Join-Path $sdkVersion.FullName 'x64/makeappx.exe'
    if (Test-Path -LiteralPath $candidate) { $makeAppx = $candidate; break }
}
if (-not $makeAppx) { throw 'Install the Windows SDK with MakeAppx before packaging.' }
$outputRoot = Join-Path $repoRoot '.build/msix'
$staging = Join-Path $outputRoot ('stage-' + [Guid]::NewGuid().ToString('N'))
$output = Join-Path $outputRoot "ArmotuSitio-IDE-$Version-x64.msix"
if (Test-Path -LiteralPath $output) { throw 'Package already exists. Retain it or choose a higher version.' }
New-Item -ItemType Directory -Path $staging -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory($archiveFile.FullName, $staging)
$staging = Join-Path $staging 'ArmotuSitio IDE'
$appExe = Join-Path $staging 'ArmotuSitio IDE.exe'
$productPath = Join-Path $staging 'resources/app/product.json'
$packagePath = Join-Path $staging 'resources/app/package.json'
if (-not (Test-Path -LiteralPath $appExe) -or -not (Test-Path -LiteralPath $productPath)) { throw 'Expected ArmotuSitio IDE release layout missing.' }
$product = Get-Content -LiteralPath $productPath -Raw | ConvertFrom-Json
$package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
if ($product.nameShort -ne 'ArmotuSitio IDE' -or $product.commit -notmatch '^[a-f0-9]{40}$') { throw 'Unexpected release product identity.' }
# Store owns updates for this distribution. A packaged installation is not writable by the Inno updater.
$product.PSObject.Properties.Remove('updateUrl')
$product | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $productPath -Encoding utf8
$assets = Join-Path $staging 'StoreAssets'
New-Item -ItemType Directory -Path $assets | Out-Null
$logo = Join-Path $staging 'resources/app/extensions/armotusitio-ide/resources/logo.png'
if (-not (Test-Path -LiteralPath $logo)) { throw 'Original branded logo missing from release.' }
Add-Type -AssemblyName System.Drawing
$image = [Drawing.Image]::FromFile($logo)
try {
    foreach ($size in @(44, 50, 150)) {
        $bitmap = [Drawing.Bitmap]::new($size, $size)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.Clear([Drawing.Color]::Transparent)
            $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $scale = [Math]::Min($size / $image.Width, $size / $image.Height)
            $width = [int]($image.Width * $scale)
            $height = [int]($image.Height * $scale)
            $graphics.DrawImage($image, [int](($size - $width) / 2), [int](($size - $height) / 2), $width, $height)
            $bitmap.Save((Join-Path $assets "Logo$size.png"), [Drawing.Imaging.ImageFormat]::Png)
        } finally { $graphics.Dispose(); $bitmap.Dispose() }
    }
} finally { $image.Dispose() }
$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
         xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
         xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
         xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
         IgnorableNamespaces="uap uap10 rescap">
  <Identity Name="AlejandroDanielDiStefano.ArmotuSitioIDE" Publisher="CN=67825ED9-9B5D-4265-9C41-7B4215F7C2B7" Version="$Version" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>ArmotuSitio IDE</DisplayName>
    <PublisherDisplayName>Alejandro Daniel Di Stefano</PublisherDisplayName>
    <Description>Open-source code editor with integrated AI-assisted development tools.</Description>
    <Logo>StoreAssets\Logo50.png</Logo>
  </Properties>
  <Resources><Resource Language="en-US" /><Resource Language="es-ES" /></Resources>
  <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19045.0" MaxVersionTested="10.0.26100.0" /></Dependencies>
  <Applications>
    <Application Id="ArmotuSitioIDE" Executable="ArmotuSitio IDE.exe" uap10:RuntimeBehavior="packagedClassicApp" uap10:TrustLevel="mediumIL">
      <uap:VisualElements DisplayName="ArmotuSitio IDE" Description="Open-source code editor" BackgroundColor="transparent" Square150x150Logo="StoreAssets\Logo150.png" Square44x44Logo="StoreAssets\Logo44.png" />
    </Application>
  </Applications>
  <Capabilities><rescap:Capability Name="runFullTrust" /></Capabilities>
</Package>
"@
$manifest | Set-Content -LiteralPath (Join-Path $staging 'AppxManifest.xml') -Encoding utf8
& $makeAppx pack /d $staging /p $output /o
if ($LASTEXITCODE -ne 0) { throw "MakeAppx failed ($LASTEXITCODE). Staging retained at $staging" }
$receipt = [ordered]@{
    package = $output
    version = $Version
    sourceVersion = $package.version
    sourceCommit = $product.commit
    sourceArchiveSha256 = $archiveHash
    packageSha256 = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
    staging = $staging
    validation = 'MakeAppx pack schema validation passed. Installation and Store certification pending.'
}
$receipt | ConvertTo-Json | Set-Content -LiteralPath ($output + '.json') -Encoding utf8
$receipt | ConvertTo-Json
