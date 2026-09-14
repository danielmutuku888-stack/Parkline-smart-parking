Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
applicationFolder = fileSystem.GetParentFolderName(WScript.ScriptFullName)

shell.CurrentDirectory = applicationFolder
shell.Run "cmd /c pythonw server.py", 0, False
WScript.Sleep 1500
shell.Run "http://localhost:8765/", 1, False