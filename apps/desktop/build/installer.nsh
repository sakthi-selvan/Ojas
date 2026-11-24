; Ojas Server service hooks for the NSIS installer.
; Upgrading a server PC: stop the service first (it runs Ojas.exe, which would lock the files),
; then start it again afterwards. Uninstalling removes the service and firewall rules; data stays.

!macro customInit
  nsExec::Exec 'sc.exe stop OjasServer'
  Sleep 3000
!macroend

!macro customInstall
  nsExec::Exec 'sc.exe query OjasServer'
  Pop $0
  ${If} $0 == 0
    ; Re-register at the (possibly new) install folder, then start.
    nsExec::ExecToLog '"$INSTDIR\resources\service\OjasService.exe" install'
  ${EndIf}
!macroend

!macro customUnInstall
  nsExec::ExecToLog '"$INSTDIR\resources\service\OjasService.exe" uninstall'
!macroend
