# Instala o Miro no Windows. No PowerShell:
#   irm https://srv1966497.hstgr.cloud/miro/instalar.ps1 | iex
# Baixa o instalador da ultima versao (GitHub Releases do projeto), instala para o seu usuario
# (sem pedir administrador) e abre o app. Depois ele se atualiza sozinho.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # a barra de progresso deixa o download 10x mais lento no PowerShell 5
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$url = 'https://github.com/JeanOlivotto/robot_assistant/releases/latest/download/Miro-Setup.exe'
$exe = Join-Path $env:TEMP 'Miro-Setup.exe'

Write-Host 'Baixando o Miro...' -ForegroundColor Cyan
Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing

# Se ja estiver aberto, fecha para o instalador poder trocar os arquivos.
Get-Process -Name 'Miro' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

Write-Host 'Instalando...' -ForegroundColor Cyan
Start-Process -FilePath $exe -ArgumentList '/S' -Wait
Remove-Item $exe -ErrorAction SilentlyContinue

$app = Join-Path $env:LOCALAPPDATA 'Programs\Miro\Miro.exe'
if (-not (Test-Path $app)) { throw "O instalador terminou, mas nao achei $app" }
Start-Process -FilePath $app

Write-Host ''
Write-Host 'Pronto! O Miro abriu no canto da tela.' -ForegroundColor Green
Write-Host ' - Na primeira vez, entre com a senha do app (o mesmo token do celular).'
Write-Host ' - Mostrar/esconder: Ctrl+Alt+K. Ele abre junto com o Windows e se atualiza sozinho.'
Write-Host ' - Desinstalar: Configuracoes > Aplicativos > Miro.'
