param([Parameter(Mandatory=$true)][string]$CasesPath)
# Development harness: actual server functions, synthetic request stream, no listener.
# Only repository-local function definitions are evaluated; remote source stays data.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$webRoot = Join-Path $projectRoot 'src\web'
$settingsDir = Join-Path $projectRoot 'runtime\filter-source-check'
$expectedHost = 'localhost:8765'
$expectedOrigin = 'http://localhost:8765'
Add-Type -AssemblyName System.Web.Extensions
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $projectRoot 'bin\server\serve.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'server syntax error' }
foreach ($fn in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]}, $false)) {
    . ([scriptblock]::Create($fn.Extent.Text))
}
. (Join-Path $projectRoot 'bin\server\filter-api.ps1')
$testSerializer = New-Object Web.Script.Serialization.JavaScriptSerializer
$testSerializer.MaxJsonLength = 67108864
$cases = $testSerializer.DeserializeObject([IO.File]::ReadAllText($CasesPath))
$passed = 0
foreach ($case in $cases) {
    $script:filterSource = @{ module = $case.module; gallery = $case.gallery }
    $script:filterExpected = $null
    $script:filterCandidate = $null
    $bytes = [Text.Encoding]::UTF8.GetBytes($filterSerializer.Serialize($case.candidate))
    $stream = New-Object IO.MemoryStream(,$bytes)
    $headers = New-Object Collections.Specialized.NameValueCollection
    $headers['Host'] = $expectedHost
    $headers['X-Photobooth'] = '1'
    $request = [pscustomobject]@{ RawUrl='/local-api/filter-candidate'; HttpMethod='PUT'; Headers=$headers; ContentType='application/json'; ContentLength64=$bytes.Length; InputStream=$stream }
    try { $result = Invoke-FilterApi $request } finally { $stream.Dispose() }
    if ($result.Status -ne $case.status) { throw "$($case.name): expected $($case.status), got $($result.Status): $($result.Note)" }
    if ($case.status -eq 200) {
        if (-not [FilterSourceParser]::Equal($filterCandidate,$case.candidate)) { throw 'server extraction parity failed' }
        if ([object]::ReferenceEquals($filterCandidate,$case.candidate)) { throw 'client object persisted' }
    } elseif ($null -ne $filterCandidate) { throw 'failed source installed candidate' }
    Write-Output ("PASS {0}: {1}" -f $case.name, $result.Status)
    $passed++
}
Write-Output ("PASS actual Invoke-FilterApi: {0} cases" -f $passed)
