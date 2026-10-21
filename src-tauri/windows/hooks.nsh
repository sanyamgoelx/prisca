; Prisca installer hooks (Tauri NSIS).
; On a real uninstall (not an update): take Prisca out of the right-click menu, remove the task
; that opens it for the Prisca printer, and remove the Prisca printer (Windows asks for permission).
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --uninstall'
  ${EndIf}
!macroend
