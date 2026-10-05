' 8.44: start the laptop's watcher (wake-watcher.sh) without a window, at
' logon. Installed once by the owner as a shortcut in shell:startup, or:
'   schtasks /Create /TN itsacv-wake-watcher /SC ONLOGON /TR "wscript.exe <this file>"
' Git Bash is taken from its default place, else from GIT_BASH.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
bash = shell.ExpandEnvironmentStrings("%GIT_BASH%")
If bash = "%GIT_BASH%" Then bash = "C:\Program Files\Git\bin\bash.exe"
script = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "wake-watcher.sh")
shell.Run """" & bash & """ """ & script & """", 0, False
