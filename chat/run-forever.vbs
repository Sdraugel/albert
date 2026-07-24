' Always-on supervisor for Albert Chat: launch Chainlit hidden, relaunch on exit.
' Point an HKCU Run entry (or a scheduled task) at this file for start-at-logon plus
' crash self-heal. Window style 0 keeps the server off the taskbar.
' Five consecutive fast exits (under 10s) mean something structural, like port 4401
' already being served or a broken venv: give up instead of spinning.
Dim sh, fso, here, fails, t0, dt, rc
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FileExists(here & "\.venv\Scripts\chainlit.exe") Then WScript.Quit 1 ' run setup.cmd first
sh.CurrentDirectory = here
fails = 0
Do
  t0 = Timer
  rc = sh.Run("""" & here & "\.venv\Scripts\chainlit.exe"" run """ & here & "\app.py"" --host 127.0.0.1 --port 4401 --headless", 0, True)
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
