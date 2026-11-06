param([Parameter(Mandatory=$true)][string]$CasesPath, [switch]$Schema)
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
function Request-FilterTest([string]$route,[string]$method,$data) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($filterSerializer.Serialize($data))
    $stream = New-Object IO.MemoryStream(,$bytes)
    $headers = New-Object Collections.Specialized.NameValueCollection
    $headers['Host'] = $expectedHost
    $headers['X-Photobooth'] = '1'
    $request = [pscustomobject]@{ RawUrl=('/local-api/filter-' + $route); HttpMethod=$method; Headers=$headers; ContentType='application/json'; ContentLength64=$bytes.Length; InputStream=$stream }
    try { return Invoke-FilterApi $request } finally { $stream.Dispose() }
}
if ($Schema) {
    $runtimeRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'runtime')) + '\'
    $settingsDir = [IO.Path]::GetFullPath((Join-Path $runtimeRoot ('schema-' + [Guid]::NewGuid().ToString('N'))))
    if (-not $settingsDir.StartsWith($runtimeRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'test cleanup boundary' }
    $script:filterStateFile = Join-Path $settingsDir 'filter.local.json'
    $baseBundle = $filterSerializer.DeserializeObject([IO.File]::ReadAllText((Join-Path $webRoot 'config\filter-builtin.json')))
    $settings = $filterSerializer.DeserializeObject('{"version":1,"settings":{}}')
    $count = 0
    try {
        foreach ($case in $cases) {
            $accepted = $true
            try { Test-FilterBundle $case.candidate } catch { $accepted = $false }
            if ($accepted -ne ($case.status -eq 200)) { throw ('schema mismatch: ' + $case.name) }
            foreach ($route in @('apply','state','rollback')) {
                $entry = @{bundle=$baseBundle;settings=$settings}
                $state = @{revision=0;active=$entry;previous=$entry}
                if ($route -eq 'state') { $state.active = @{bundle=$case.candidate;settings=$settings} }
                if ($route -eq 'rollback') { $state.previous = @{bundle=$case.candidate;settings=$settings} }
                $before = $filterSerializer.Serialize($state)
                Write-SettingsFile $filterStateFile ([Text.Encoding]::UTF8.GetBytes($before))
                $script:filterCandidate = $case.candidate
                $data = @{revision=0;settings=$settings;before=$settings;id=($case.candidate.meta.sha256 + ':' + $case.candidate.meta.htmlSha256)}
                $method = if ($route -eq 'state') { 'PUT' } else { 'POST' }
                $result = Request-FilterTest $route $method $data
                if ($result.Status -ne $case.status) { throw ("transition {0}/{1}: {2} {3}" -f $case.name,$route,$result.Status,$result.Note) }
                if ($case.status -eq 400) {
                    if ([IO.File]::ReadAllText($filterStateFile) -cne $before) { throw 'rejected transition changed file' }
                } else {
                    $read = Read-FilterState
                    Test-FilterBundle $read.active.bundle
                    if ($read.revision -ne 1 -or -not [FilterSourceParser]::Equal($read.active.bundle,$case.candidate)) { throw 'saved/read bundle mismatch' }
                }
            }
            Write-Output ("PASS schema/apply/save/rollback/read {0}: {1}" -f $case.name,$case.status)
            $count++
        }
        foreach ($number in @([double]::NaN,[double]::PositiveInfinity,[double]::NegativeInfinity)) {
            $bad = $filterSerializer.DeserializeObject($filterSerializer.Serialize($baseBundle))
            $bad.preset.layers[0][0] = $number
            $rejected = $false
            try { Test-FilterBundle $bad } catch { $rejected = $true }
            if (-not $rejected) { throw 'non-finite geometry accepted' }
        }
        Write-Output ("PASS persisted schema: {0} cases x 3 transitions; 3 non-finite rejected" -f $count)
    } finally { if ([IO.Directory]::Exists($settingsDir)) { Remove-Item -LiteralPath $settingsDir -Recurse -Force } }
    exit 0
}
$passed = 0
foreach ($case in $cases) {
    if ($case.ContainsKey('sourceAccepted')) {
        Initialize-FilterParser
        $sourceAccepted = $true
        try { [void][FilterSourceParser]::Extract($case.module,$case.gallery,[IO.File]::ReadAllText((Join-Path $webRoot 'config\filter-builtin.json'))) } catch { $sourceAccepted = $false }
        if ($sourceAccepted -ne $case.sourceAccepted) { throw ('independent extraction mismatch: ' + $case.name) }
    }
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
