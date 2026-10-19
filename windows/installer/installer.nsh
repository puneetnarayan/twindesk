; TwinDesk — Copyright (C) 2026 inukaasith. GPL-3.0, see LICENSE.
; NSIS hooks for electron-builder (installer/build.js). The installer runs elevated (per-machine),
; so it adds the same firewall rules the app's Fix button would (firewall.js), for every network
; profile so a standard account on a Public network never needs Fix; the uninstaller removes them. A helper (or our adb server) left running would lock its .exe, so it is stopped first.

!macro customInit
  nsExec::Exec 'taskkill /f /im macshare-winhelper.exe'
  nsExec::Exec '"$INSTDIR\resources\app\windows\vendor\adb\adb.exe" kill-server'
!macroend

!macro customUnInit
  nsExec::Exec 'taskkill /f /im macshare-winhelper.exe'
  nsExec::Exec '"$INSTDIR\resources\app\windows\vendor\adb\adb.exe" kill-server'
!macroend

; In place of electron-builder's "TwinDesk is running, close it" check, before the old version's
; uninstaller and the file copy: a running TwinDesk is closed rather than asked about, and the old
; app folder goes, so every file is the new version's (none left over from earlier releases).
!macro customCheckAppRunning
  nsExec::Exec 'taskkill /f /t /im TwinDesk.exe'
  nsExec::Exec 'taskkill /f /im macshare-winhelper.exe'
  Sleep 500
  RMDir /r "$INSTDIR\resources\app"
!macroend

!macro customInstall
  ; Renamed from MacShare: its rules (and its Program Files folder's exe) go.
  nsExec::Exec 'netsh advfirewall firewall delete rule name="MacShare"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="MacShare (TCP 47800)"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="TwinDesk" program="$INSTDIR\TwinDesk.exe"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="TwinDesk" dir=in action=allow program="$INSTDIR\TwinDesk.exe" profile=any enable=yes'
  ; This PC also listens (PC ↔ PC host), so the port gets its own rule.
  nsExec::Exec 'netsh advfirewall firewall delete rule name="TwinDesk (TCP 47800)"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="TwinDesk (TCP 47800)" dir=in action=allow protocol=TCP localport=47800 program="$INSTDIR\TwinDesk.exe" profile=any enable=yes'
  ; A phone: adb finds its wireless debugging over mDNS (phone-bridge.js).
  nsExec::Exec 'netsh advfirewall firewall delete rule name="TwinDesk (adb)"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="TwinDesk (adb)" dir=in action=allow program="$INSTDIR\resources\app\windows\vendor\adb\adb.exe" profile=any enable=yes'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="TwinDesk" program="$INSTDIR\TwinDesk.exe"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="TwinDesk (TCP 47800)"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="TwinDesk (adb)"'
  ; The pinned Mac apps' Start menu folder is per user (the app makes it in Roaming).
  SetShellVarContext current
  RMDir /r "$APPDATA\Microsoft\Windows\Start Menu\Programs\TwinDesk Apps"
  RMDir /r "$APPDATA\Microsoft\Windows\Start Menu\Programs\MacShare Apps"
  ; Explorer › Send to › "<peer> (TwinDesk)" (sendto.js).
  Delete "$APPDATA\Microsoft\Windows\SendTo\* (TwinDesk).lnk"
  Delete "$APPDATA\Microsoft\Windows\SendTo\* (MacShare).lnk"
  SetShellVarContext all
!macroend
