param(
    [Parameter(Mandatory = $true)]
    [string]$AwsRegion,

    [Parameter(Mandatory = $true)]
    [string]$AwsAccountId,

    [Parameter(Mandatory = $true)]
    [string]$RepositoryName,

    [string]$ImageTag = "latest",
    [string]$ContextPath = "D:\ozon\ozon_websit\frontend",
    [string]$DockerfilePath = "D:\ozon\ozon_websit\frontend\Dockerfile",
    [string]$ApiBaseUrl = "https://api.example.com/api/v1",
    [switch]$CreateRepositoryIfMissing
)

$ErrorActionPreference = "Stop"

function Assert-Command {
    param([string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $Name"
    }
}

Assert-Command -Name "aws"
Assert-Command -Name "docker"

$registry = "$AwsAccountId.dkr.ecr.$AwsRegion.amazonaws.com"
$imageUri = "$registry/$RepositoryName`:$ImageTag"

if ($CreateRepositoryIfMissing) {
    $describeFailed = $false
    try {
        aws ecr describe-repositories --region $AwsRegion --repository-names $RepositoryName | Out-Null
    }
    catch {
        $describeFailed = $true
    }

    if ($describeFailed) {
        Write-Host "Creating ECR repository $RepositoryName in $AwsRegion"
        aws ecr create-repository --region $AwsRegion --repository-name $RepositoryName | Out-Null
    }
}

Write-Host "Logging in to ECR $registry"
aws ecr get-login-password --region $AwsRegion | docker login --username AWS --password-stdin $registry

Write-Host "Building frontend image $imageUri"
docker build `
    -f $DockerfilePath `
    --build-arg VITE_API_BASE_URL=$ApiBaseUrl `
    -t $imageUri `
    $ContextPath

Write-Host "Pushing frontend image $imageUri"
docker push $imageUri

Write-Host "Frontend image pushed: $imageUri"
