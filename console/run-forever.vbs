' Always-on supervisor for the Albert Console server: launch hidden, relaunch on exit.
' Use this when Task Scheduler is unavailable (point an HKCU Run entry at it); it replaces
' both the task's launcher and its 1-minute watchdog. Window style 0 keeps node hidden.
' Five consecutive fast exits (under 10s) mean something structural, like the port already
' being served or a broken install: give up instead of spinning.
' Self-locating on purpose: server.mjs must sit next to this script, so the same file works
' from the repo and from the installed console directory.
Dim sh, here, fails, t0, dt, rc
Set sh = CreateObject("WScript.Shell")
here = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
fails = 0
Do
  t0 = Timer
  rc = sh.Run("node """ & here & "\server.mjs""", 0, True)
  dt = Timer - t0
  If dt < 0 Then dt = dt + 86400
  If dt < 10 Then
    fails = fails + 1
    If fails >= 5 Then Exit Do
  Else
    fails = 0
  End If
  WScript.Sleep 5000
Loop
