' Hidden launcher for the Albert Console server, started by the AlbertConsole Scheduled Task.
' Window style 0 keeps the node console off the taskbar.
' bWaitOnReturn is True and the exit code is propagated on purpose: the launcher must stay alive
' for as long as the server does, otherwise Task Scheduler sees the action finish immediately,
' marks the task complete, and its restart-on-failure settings can never fire.
' node is resolved from PATH; the installer must register the task with an environment where node is reachable.
Dim rc
rc = CreateObject("WScript.Shell").Run("node ""{{CONSOLE_DIR}}\server.mjs""", 0, True)
WScript.Quit rc
