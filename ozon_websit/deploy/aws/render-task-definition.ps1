param(
    [Parameter(Mandatory = $true)]
    [string]$TemplatePath,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath,

    [Parameter(Mandatory = $true)]
    [hashtable]$Replacements
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $TemplatePath)) {
    throw "Template file not found: $TemplatePath"
}

$content = Get-Content $TemplatePath -Raw -Encoding UTF8

foreach ($entry in $Replacements.GetEnumerator()) {
    $token = "<$($entry.Key)>"
    $replacement = [string]$entry.Value
    $content = $content.Replace($token, $replacement)
}

$outputDirectory = Split-Path -Path $OutputPath -Parent
if ($outputDirectory -and -not (Test-Path $outputDirectory)) {
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}

Set-Content -Path $OutputPath -Value $content -Encoding UTF8
Write-Host "Rendered task definition: $OutputPath"
