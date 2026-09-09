; AI Copilot sets up its Whisper venv and .env inside %APPDATA% on first launch,
; so the installer does not bootstrap them into the install directory.

!macro customInstall
  ; The bundled whisper.cpp binaries (resources\whisper-cpp\win\*.dll,
  ; main.exe) are built with MSVC and require the Microsoft Visual C++
  ; Redistributable at runtime (MSVCP140.dll / VCRUNTIME140.dll /
  ; VCRUNTIME140_1.dll -- confirmed via `strings` on the shipped DLLs).
  ; That's not part of Windows by default, so on a genuinely clean machine
  ; that lacks it, the bundled speech engine fails with no clear signal why
  ; -- it just reports "Speech provider whisper is not available", the same
  ; symptom a missing/broken binary produces for an entirely different
  ; reason. electron-builder's win.extraResources (see package.json) copies
  ; the redistributable's own official installer to
  ; $INSTDIR\resources\vc_redist.x64.exe (fetched fresh at build time by
  ; scripts/download-vcredist.js, from Microsoft's own permalink -- see
  ; that script for why it isn't committed to git). Run it silently here so
  ; every install has the runtime it needs, with no extra step for the
  ; user. The installer is idempotent and fast (a few seconds) when the
  ; redistributable is already present, so this is safe to run
  ; unconditionally on every install/upgrade, not just a first install.
  ExecWait '"$INSTDIR\resources\vc_redist.x64.exe" /install /quiet /norestart'
!macroend

!macro customUnInstall
!macroend
