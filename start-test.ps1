Set-Location 'c:/Users/Brahma/WorkBuddy/Claw'
$proc = Start-Process -FilePath 'node' -ArgumentList 'dist/app.js' -NoNewWindow -PassThru -RedirectStandardOutput 'output.log' -RedirectStandardError 'error.log'
Start-Sleep -Seconds 6
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Write-Host "Process stopped"
