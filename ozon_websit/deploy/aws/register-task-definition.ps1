param(
    [Parameter(Mandatory = $true)]
    [string]$AwsRegion,

    [Parameter(Mandatory = $true)]
    [string]$TemplatePath,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath,

    [Parameter(Mandatory = $true)]
    [hashtable]$Replacements
)

$ErrorActionPreference = "Stop"

function Assert-Command {
    param([string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $Name"
    }
}

Assert-Command -Name "aws"

$renderScript = "D:\ozon\ozon_websit\deploy\aws\render-task-definition.ps1"

& $renderScript -TemplatePath $TemplatePath -OutputPath $OutputPath -Replacements $Replacements

Write-Host "Registering ECS task definition from $OutputPath"
aws ecs register-task-definition --region $AwsRegion --cli-input-json "file://$OutputPath"
