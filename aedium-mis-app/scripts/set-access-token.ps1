# Prompts for a Supabase personal access token (sbp_...) and saves it to .env.local without echoing it.
$envFile = Join-Path (Split-Path $PSScriptRoot -Parent) ".env.local"
$secure = Read-Host "Paste the Supabase personal access token (sbp_...)" -AsSecureString
$token = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)).Trim()
if (-not $token.StartsWith("sbp_")) { Write-Host "That does not start with sbp_. Nothing saved." -ForegroundColor Yellow; exit 1 }
$lines = @(Get-Content $envFile | Where-Object { $_ -notmatch '^SUPABASE_ACCESS_TOKEN=' })
$lines += "SUPABASE_ACCESS_TOKEN=$token"
[IO.File]::WriteAllLines($envFile, $lines)
Write-Host "Saved to .env.local. Tell Claude it is done." -ForegroundColor Green
