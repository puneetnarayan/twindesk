# TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
# Run elevated (vdd.js): removes the Extend tasks and — only if MacShare installed it —
# the Virtual Display Driver device and driver package. C:\VirtualDisplayDriver is left alone.
param([Parameter(Mandatory = $true)][string]$Log)
$ErrorActionPreference = 'Stop'
$HwId = 'Root\MttVDD'
try {
  $svc = New-Object -ComObject Schedule.Service
  $svc.Connect()
  try {
    $folder = $svc.GetFolder('\MacShare')
    foreach ($n in 'Extend on', 'Extend off') { try { $folder.DeleteTask($n, 0) } catch {} }
  } catch {}

  $dir = Join-Path $env:ProgramData 'MacShare\vdd'
  if (Test-Path (Join-Path $dir 'installed-by-macshare')) {
    $devs = @(Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | Where-Object { $_.HardwareID -contains $HwId })
    $infs = @(Get-CimInstance Win32_PnPSignedDriver | Where-Object { $devs.InstanceId -contains $_.DeviceID } | ForEach-Object { $_.InfName } | Sort-Object -Unique)
    foreach ($d in $devs) { & pnputil.exe /remove-device $d.InstanceId | Out-Null }
    foreach ($i in $infs) { if ($i -like 'oem*.inf') { & pnputil.exe /delete-driver $i /uninstall /force | Out-Null } }
    Remove-Item -Recurse -Force $dir
  }
  Set-Content -Path $Log -Value 'ok'
} catch {
  Set-Content -Path $Log -Value ('error: ' + $_.Exception.Message)
}
