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

# Onde ele instalou: o proprio instalador anota no registro (a pasta nao se chama necessariamente "Miro").
function Achar-Miro {
    $chaves = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
              'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
              'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    foreach ($r in (Get-ItemProperty $chaves -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Miro*' })) {
        $dir = $r.InstallLocation
        if (-not $dir -and $r.UninstallString) { $dir = Split-Path ($r.UninstallString -replace '^"([^"]+)".*$', '$1') }
        if ($dir -and (Test-Path (Join-Path $dir 'Miro.exe'))) { return (Join-Path $dir 'Miro.exe') }
    }
    # Sem registro: procura nas pastas de programas.
    foreach ($base in "$env:LOCALAPPDATA\Programs", $env:ProgramFiles) {
        $achado = Get-ChildItem -Path $base -Filter 'Miro.exe' -Recurse -Depth 2 -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($achado) { return $achado.FullName }
    }
    return $null
}

$app = Achar-Miro
if (-not $app) { throw 'O instalador terminou, mas nao achei o Miro.exe. Procure "Miro" no Menu Iniciar.' }
Write-Host "Instalado em $(Split-Path $app)"
Start-Process -FilePath $app

Write-Host ''
Write-Host 'Pronto! O Miro abriu no canto da tela.' -ForegroundColor Green
Write-Host ' - Na primeira vez, entre com a senha do app (o mesmo token do celular).'
Write-Host ' - Mostrar/esconder: Ctrl+Alt+K. Ele abre junto com o Windows e se atualiza sozinho.'
Write-Host ' - Desinstalar: Configuracoes > Aplicativos > Miro.'
