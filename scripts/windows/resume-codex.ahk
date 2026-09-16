#Requires AutoHotkey v2.0
#SingleInstance Force

; Phase 1 fallback only.
; This script drives the VS Code UI and is intentionally kept separate from the
; Phase 2 app-server implementation. Adjust the input coordinates if necessary.

SetTitleMatchMode 2

resumeText := "继续。从中断处恢复，先检查当前任务状态和工作区已有修改，不要重复已经完成的工作。"

if !WinExist("ahk_exe Code.exe") {
    Run "code"
    Sleep 5000
}

WinActivate "ahk_exe Code.exe"
if !WinWaitActive("ahk_exe Code.exe", , 10) {
    MsgBox "Unable to activate VS Code."
    ExitApp 1
}

; Open Codex sidebar via Command Palette.
Send "^+p"
Sleep 600
SendText "Codex: Open Codex Sidebar"
Sleep 400
Send "{Enter}"
Sleep 1800

; UI fallback: focus the Codex input using a configurable screen coordinate.
; Change these values for your VS Code layout / DPI scale.
inputX := 1650
inputY := 930
Click inputX, inputY
Sleep 300
SendText resumeText
Send "{Enter}"
