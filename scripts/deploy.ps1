param(
  [Parameter(Mandatory=$true)][string]$ResourceGroup,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-z][a-z0-9]{3,15}$')][string]$NamePrefix,
  [string]$Location = 'eastus2',
  [string]$Subscription,
  [switch]$UpdateOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$taskRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $taskRoot
function Invoke-Azure {
  param([string[]]$Arguments)
  $taskOutput = & az @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Azure CLI failed: $($Arguments[0]) $($Arguments[1])" }
  return $taskOutput
}
function Invoke-Npm {
  param([string[]]$Arguments)
  & npm @Arguments
  if ($LASTEXITCODE -ne 0) { throw 'npm command failed.' }
}
if (-not (Test-Path -LiteralPath '.env')) { throw 'Create .env from .env.example first.' }
$taskEnv = @{}
foreach ($taskLine in Get-Content -LiteralPath '.env') {
  if ($taskLine -match '^([A-Z_][A-Z_0-9]*)=(.*)$') { $taskEnv[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'") }
}
foreach ($taskKey in @('SPOTIFY_CLIENT_ID','SPOTIFY_CLIENT_SECRET','HOST_PASSWORD','SESSION_SECRET')) {
  if (-not $taskEnv[$taskKey]) { throw "Missing $taskKey in .env." }
}
if ($taskEnv['HOST_PASSWORD'].Length -lt 12 -or $taskEnv['SESSION_SECRET'].Length -lt 32) { throw 'Host password/session secret are too short.' }
if ($Subscription) { Invoke-Azure @('account','set','--subscription',$Subscription) | Out-Null }
Invoke-Azure @('account','show','--query','name','-o','tsv') | Out-Null
$taskFunction = "$NamePrefix-api"
$taskWeb = "$NamePrefix-web"
$taskStorage = "${NamePrefix}store"
$taskCosmos = "$NamePrefix-db"
if (-not $UpdateOnly) {
  Write-Host "Provisioning demo resources in $ResourceGroup ($Location)."
  Invoke-Azure @('group','create','--name',$ResourceGroup,'--location',$Location,'--tags','project=vibeq-player','purpose=demo','-o','none')
  Invoke-Azure @('storage','account','create','--name',$taskStorage,'--resource-group',$ResourceGroup,'--location',$Location,'--sku','Standard_LRS','--allow-blob-public-access','false','--min-tls-version','TLS1_2','-o','none')
  Invoke-Azure @('functionapp','create','--name',$taskFunction,'--resource-group',$ResourceGroup,'--storage-account',$taskStorage,'--flexconsumption-location',$Location,'--runtime','node','--runtime-version','22','--instance-memory','512','--maximum-instance-count','40','-o','none')
  Invoke-Azure @('cosmosdb','create','--name',$taskCosmos,'--resource-group',$ResourceGroup,'--locations',"regionName=$Location",'--capabilities','EnableServerless','--default-consistency-level','Session','-o','none')
  Invoke-Azure @('cosmosdb','sql','database','create','--account-name',$taskCosmos,'--resource-group',$ResourceGroup,'--name','vibeq','-o','none')
  Invoke-Azure @('cosmosdb','sql','container','create','--account-name',$taskCosmos,'--resource-group',$ResourceGroup,'--database-name','vibeq','--name','documents','--partition-key-path','/collection','--ttl','-1','-o','none')
  Invoke-Azure @('staticwebapp','create','--name',$taskWeb,'--resource-group',$ResourceGroup,'--location','eastus2','--sku','Free','-o','none')
}
$taskHostname = (Invoke-Azure @('staticwebapp','show','--name',$taskWeb,'--resource-group',$ResourceGroup,'--query','defaultHostname','-o','tsv')).Trim()
$taskApiHostname = (Invoke-Azure @('functionapp','show','--name',$taskFunction,'--resource-group',$ResourceGroup,'--query','properties.defaultHostName || defaultHostName','-o','tsv')).Trim()
$taskOrigin = "https://$taskHostname"
if ($taskEnv['PUBLIC_SITE_ORIGIN']) {
  $taskCustomOrigin = [uri]$taskEnv['PUBLIC_SITE_ORIGIN']
  if ($taskCustomOrigin.Scheme -ne 'https' -or $taskCustomOrigin.GetLeftPart([System.UriPartial]::Authority) -ne $taskEnv['PUBLIC_SITE_ORIGIN']) { throw 'PUBLIC_SITE_ORIGIN must be an HTTPS origin without a path or trailing slash.' }
  $taskOrigin = $taskEnv['PUBLIC_SITE_ORIGIN']
}
$taskCallback = "https://$taskApiHostname/api/spotify/callback"
$taskCosmosEndpoint = (Invoke-Azure @('cosmosdb','show','--name',$taskCosmos,'--resource-group',$ResourceGroup,'--query','documentEndpoint','-o','tsv')).Trim()
$taskCosmosKey = (Invoke-Azure @('cosmosdb','keys','list','--name',$taskCosmos,'--resource-group',$ResourceGroup,'--query','primaryMasterKey','-o','tsv')).Trim()
$taskAppSettings = @{
  APP_ORIGIN=$taskOrigin; SPOTIFY_REDIRECT_URI=$taskCallback;
  SPOTIFY_CLIENT_ID=$taskEnv['SPOTIFY_CLIENT_ID']; SPOTIFY_CLIENT_SECRET=$taskEnv['SPOTIFY_CLIENT_SECRET'];
  HOST_PASSWORD=$taskEnv['HOST_PASSWORD']; SESSION_SECRET=$taskEnv['SESSION_SECRET'];
  STORAGE_DRIVER='cosmos'; COSMOS_ENDPOINT=$taskCosmosEndpoint; COSMOS_KEY=$taskCosmosKey; COSMOS_DATABASE='vibeq';
  ENABLE_ARCHIVES='true'; ENABLE_ARTWORK='false'; ENABLE_TRIVIA='false'; ENABLE_BROWSER_PLAYER='false'; ADDON_DAILY_LIMIT='10'
}
foreach ($taskKey in @('ENABLE_ARCHIVES','ENABLE_ARTWORK','ENABLE_TRIVIA','ENABLE_BROWSER_PLAYER','AI_BASE_URL','AI_API_KEY','AI_AUTH_HEADER','AI_IMAGE_MODEL','AI_TRIVIA_MODEL','AI_TRIVIA_FORMAT_MODEL','AI_TRIVIA_SEARCH_TOOL','ADDON_DAILY_LIMIT')) {
  if ($taskEnv[$taskKey]) { $taskAppSettings[$taskKey] = $taskEnv[$taskKey] }
}
if ($taskAppSettings['ENABLE_ARTWORK'] -eq 'true') {
  $taskConnection = (Invoke-Azure @('storage','account','show-connection-string','--name',$taskStorage,'--resource-group',$ResourceGroup,'--query','connectionString','-o','tsv')).Trim()
  $taskAppSettings['ARTWORK_STORAGE_CONNECTION_STRING'] = $taskConnection
  $env:AZURE_STORAGE_CONNECTION_STRING = $taskConnection
  try { Invoke-Azure @('storage','container','create','--name','artwork','--public-access','off','-o','none') }
  finally { Remove-Item Env:AZURE_STORAGE_CONNECTION_STRING }
}
New-Item -ItemType Directory -Path '.deploy' -Force | Out-Null
$taskSettingsPath = Join-Path $taskRoot '.deploy/settings.json'
try {
  $taskAppSettings | ConvertTo-Json | Set-Content -LiteralPath $taskSettingsPath -Encoding utf8
  Invoke-Azure @('functionapp','config','appsettings','set','--name',$taskFunction,'--resource-group',$ResourceGroup,'--settings',"@$taskSettingsPath",'-o','none')
} finally { if (Test-Path -LiteralPath $taskSettingsPath) { Remove-Item -LiteralPath $taskSettingsPath } }
Invoke-Azure @('functionapp','cors','add','--name',$taskFunction,'--resource-group',$ResourceGroup,'--allowed-origins',$taskOrigin,'-o','none')
Invoke-Npm @('ci')
Invoke-Npm @('ci','--prefix','api')
Invoke-Npm @('test')
Invoke-Npm @('run','functions:prepare')
$taskStage = (Resolve-Path -LiteralPath '.deploy/api').Path
$taskZip = Join-Path $taskRoot '.deploy/api.zip'
if (Test-Path -LiteralPath $taskZip) { Remove-Item -LiteralPath $taskZip }
Add-Type -AssemblyName System.IO.Compression.FileSystem
# Include only source/lockfiles. Azure installs Linux dependencies via remote build.
$taskArchive = [System.IO.Compression.ZipFile]::Open($taskZip, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  $taskPackageFiles = @('package.json','package-lock.json','host.json','functions.js','LICENSE') | ForEach-Object { Get-Item -LiteralPath (Join-Path $taskStage $_) }
  $taskPackageFiles += Get-ChildItem -LiteralPath (Join-Path $taskStage 'server') -Recurse -File
  foreach ($taskFile in $taskPackageFiles) {
    $taskEntry = [System.IO.Path]::GetRelativePath($taskStage, $taskFile.FullName).Replace('\','/')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($taskArchive, $taskFile.FullName, $taskEntry) | Out-Null
  }
} finally { $taskArchive.Dispose() }
Invoke-Azure @('functionapp','deployment','source','config-zip','--name',$taskFunction,'--resource-group',$ResourceGroup,'--src',$taskZip,'--build-remote','true','-o','none')
$env:VITE_API_BASE_URL = "https://$taskApiHostname"
Invoke-Npm @('run','build')
$env:SWA_CLI_DEPLOYMENT_TOKEN = (Invoke-Azure @('staticwebapp','secrets','list','--name',$taskWeb,'--resource-group',$ResourceGroup,'--query','properties.apiKey','-o','tsv')).Trim()
try {
  & npx --yes '@azure/static-web-apps-cli@2.0.10' deploy ./dist --env production --app-name $taskWeb --resource-group $ResourceGroup
  if ($LASTEXITCODE -ne 0) { throw 'Static Web Apps deployment failed.' }
} finally { Remove-Item Env:SWA_CLI_DEPLOYMENT_TOKEN; Remove-Item Env:VITE_API_BASE_URL }
@{ resourceGroup=$ResourceGroup; namePrefix=$NamePrefix; location=$Location; url=$taskOrigin; playerUrl="$taskOrigin/player/"; api="https://$taskApiHostname"; spotifyCallback=$taskCallback } | ConvertTo-Json | Set-Content -LiteralPath '.deploy/demo.json' -Encoding utf8
Write-Host "Project website: $taskOrigin"
Write-Host "Demo URL: $taskOrigin/player/"
Write-Host "Register this exact Spotify redirect URI: $taskCallback"
Write-Host 'Host password is stored only in your ignored .env file and Azure application settings.'
