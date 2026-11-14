# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root.
param(
    [Parameter(Mandatory)][ValidateSet('sign', 'verify')][string]$Mode,
    [Parameter(Mandatory)][string]$Target
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $env:ATS_WINDOWS_PUBLISHER) { throw 'Missing ATS_WINDOWS_PUBLISHER' }
$file = Get-Item -LiteralPath $Target
if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe signing target' }
if ($Mode -eq 'sign') {
    foreach ($key in @('ATS_SIGNTOOL', 'ATS_SIGNING_DLIB', 'ATS_SIGNING_ENDPOINT', 'ATS_SIGNING_ACCOUNT', 'ATS_SIGNING_PROFILE', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET')) {
        if (-not [Environment]::GetEnvironmentVariable($key)) { throw "Missing $key" }
    }
    $metadata = Join-Path ([IO.Path]::GetTempPath()) ('ats-signing-' + [Guid]::NewGuid().ToString() + '.json')
    try {
        @{
            Endpoint = $env:ATS_SIGNING_ENDPOINT
            CodeSigningAccountName = $env:ATS_SIGNING_ACCOUNT
            CertificateProfileName = $env:ATS_SIGNING_PROFILE
            ExcludeCredentials = @('ManagedIdentityCredential', 'WorkloadIdentityCredential', 'SharedTokenCacheCredential', 'VisualStudioCredential', 'VisualStudioCodeCredential', 'AzureCliCredential', 'AzurePowerShellCredential', 'AzureDeveloperCliCredential', 'InteractiveBrowserCredential')
        } | ConvertTo-Json | Set-Content -LiteralPath $metadata -Encoding UTF8
        & $env:ATS_SIGNTOOL sign /fd SHA256 /tr http://timestamp.acs.microsoft.com /td SHA256 /dlib $env:ATS_SIGNING_DLIB /dmdf $metadata $file.FullName
        if ($LASTEXITCODE -ne 0) { throw 'Authenticode signing failed' }
    } finally {
        if (Test-Path -LiteralPath $metadata) { Remove-Item -LiteralPath $metadata -Force }
    }
}
$signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
if ($signature.Status -ne 'Valid' -or $signature.SignatureType -ne 'Authenticode' -or -not $signature.SignerCertificate -or -not $signature.TimeStamperCertificate) {
    throw "Missing valid timestamped Authenticode signature: $($file.Name)"
}
if ($signature.SignerCertificate.Subject -cne $env:ATS_WINDOWS_PUBLISHER) {
    throw "Unexpected Authenticode publisher: $($file.Name)"
}
Write-Output "Verified Authenticode: $($file.Name)"
