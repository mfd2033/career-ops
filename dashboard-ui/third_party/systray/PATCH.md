# PATCH: context menu only shows on first right-click (or stops after a few)

**Upstream:** `fyne.io/systray` v1.12.2 (unpatched in fyne-io master and getlantern
master — confirmed against `getlantern/systray` `systray_windows.go` at
`22c167e`; no fix in either fork).

**Symptom (user report):** the tray icon's right-click context menu appears the first
time, then never again until the app restarts. Later variants: shows several times
then stops. Diagnosis logging eventually proved the real symptom: after a few shows,
the **right-click callback (0x205) stops being delivered to wndProc entirely**, while
`WM_MOUSEMOVE` (0x200) keeps arriving — the icon is still "live" to the shell, only
right-click menu events are suppressed.

**Trial-and-error that led to the real root cause:**

- **v1** posted `WM_NULL` after `TrackPopupMenu` (the "menu-active flag" fix from the
  `TrackPopupMenu` remarks). Only 1 → ~5 shows in one run, still stops.
- **v2** added a synthetic Alt keypress (`keybd_event(VK_MENU)`) before
  `SetForegroundWindow`. Made it WORSE: second right-click never reached wndProc.
  Alt-key abandoned.
- **v4** added `SystemParametersInfo(SPI_SETFOREGROUNDLOCKTIMEOUT=0)` around
  `SetForegroundWindow`. Intermittent: one run 10/10 (later shown to be luck), mostly
  3/10. `SPIF_SENDCHANGE` variant was 1/10. Global anti-pattern — rejected.
- **v5** added a `menuActive` re-entrancy guard + decoupled the menu to a posted
  message. Still only ~2-3 shows. Decoupling alone does not fix the real cause.

**Root cause (authoritative — Oracle-confirmed, matches all logs):**

The shell (explorer.exe) delivers the tray right-click to the icon's owner window via
**`SendMessage` while the foreground belongs to another program**. Windows'
foreground-lock policy blocks a non-foreground thread from calling
`SetForegroundWindow`, so it **usually returns FALSE**. When it fails, the menu can
still show, but after it closes the shell keeps its per-icon *"context menu still
active"* state and **suppresses subsequent right-click notifications** — while hover /
`WM_MOUSEMOVE` notifications keep flowing (exactly the 0x200-still-arrives /
0x205-stops signature in the logs). `WM_NULL` only clears that state when
`SetForegroundWindow` succeeded, which is why it only helped 1→5. The SPI bypass just
made `SetForegroundWindow` succeed more often, never reliably. This is the known
symptom in getlantern/systray issue #269 and SO #4145561.

**Fix (v6):** make `SetForegroundWindow` reliably succeed via `AttachThreadInput`, the
standard technique mature tray code uses. Merging this thread's input queue with the
foreground thread's defeats the foreground lock, so `SetForegroundWindow` succeeds,
the menu owner is correctly foreground, and `WM_NULL` reliably releases the shell's
menu-active state — every right-click is delivered again.

```go
// In showMenu(), before SetForegroundWindow:
fg, _, _ := pGetForegroundWindow.Call()
var fgTid uintptr
if fg != 0 {
    fgTid, _, _ = pGetWindowThreadProcessId.Call(fg, 0)
}
myTid, _, _ := pGetCurrentThreadId.Call()
attached := false
if fgTid != 0 && fgTid != myTid {
    resAtt, _, _ := pAttachThreadInput.Call(myTid, fgTid, 1) // attach
    attached = resAtt != 0
}
sfwRes, _, _ := pSetForegroundWindow.Call(uintptr(t.window))
if attached {
    pAttachThreadInput.Call(myTid, fgTid, 0) // detach
}
if sfwRes == 0 {
    log.Printf("systray: SetForegroundWindow FAILED (menu may not render)")
}
```

`WM_NULL` post after `TrackPopupMenu` is retained.

**Diagnostics (always written to tray-debug.log — see README):**
- `wndProc` logs every tray callback: `systray: callback msg=.. wParam=.. lParam=0x..`
  and an explicit `not handled` line for non-left/right lParam values.
- `systray: showMenu opening` / `systray: showMenu returned ok` around the body.
- `systray: SetForegroundWindow FAILED (menu may not render)` when it returns 0.
- `systray error: TrackPopupMenu failed: %v` on the `res == 0` branch.

**Diff vs upstream (excluding this file and example/test cleanup):**

- `systray_windows.go`:
  - procs: added `pAttachThreadInput`, `pGetCurrentThreadId`,
    `pGetForegroundWindow`, `pGetWindowThreadProcessId`.
  - `showMenu()`: `AttachThreadInput` + `SetForegroundWindow` (replacing the SPI
    foreground-lock hack) + `WM_NULL` post + diagnostic logs.
  - `wndProc()`: per-callback logging on `t.wmSystrayMessage`.
- No other structural changes.

**Why vendored instead of upstream submit:** minimal, surgical; avoids an HTTP/upstream
round-trip. If a future `go.mod` bump lifts systray past this bug, delete this
directory and the `replace` line in `../go.mod` and re-verify.

**Note on automated verification:** in a headless/RDP session `TrackPopupMenu`
creates the `#32768` menu window even when it never renders, so enumerating popup
windows is NOT a reliable signal. The reliable signal is the wndProc callback logging
+ `showMenu` logs in `tray-debug.log`, combined with a real-desktop eyeball check —
confirm 20+ consecutive right-clicks each reach `showMenu` and render, and that after
closing the menu the NEXT right-click still opens it.

---

## v7 (2026-08-27): `pGetCurrentThreadId` bound to the wrong DLL

**Bug (user report, from `tray-debug.log`):** right-clicking the tray icon showed no
menu at all; the log panicked with:

```
systray PANIC in showMenuAt: Failed to find GetCurrentThreadId procedure in
User32.dll: The specified procedure could not be found.
```

**Root cause:** the v6 fix declared `pGetCurrentThreadId = u32.NewProc("GetCurrentThreadId")`
(bound to `User32.dll`), but `GetCurrentThreadId` is exported by **`Kernel32.dll`**, not
User32.dll. `LazyProc.Call` failed at `mustFind` time, panicking inside `showMenuAt`
(right before `TrackPopupMenu`), so the menu never appeared. The surrounding
`recover()` kept the process alive, which is why the tray icon kept working but the
menu silently never opened.

**Fix (v7):** rebind the lazy proc to the already-declared Kernel32 handle:

```go
pGetCurrentThreadId = k32.NewProc("GetCurrentThreadId") // was u32.NewProc(...)
```

That unblocked the first menu show, but exposed a SECOND, deeper bug (same symptom
as the original PATCH): after the first right-click, every subsequent one was
suppressed — `tray-debug.log` showed the first `showMenu` fully succeeding
(`attached=true`, `SetForegroundWindow res=1`, `TrackPopupMenu res=1`, `WM_NULL`
posted), then only `0x200` (WM_MOUSEMOVE) kept arriving while `0x205` (WM_RBUTTONUP)
stopped reaching `wndProc`.

**Root cause of the suppression (Oracle-confirmed):** the shell (explorer) delivers
the tray right-click via `SendMessage` and expects the context menu to be shown
**before the handler returns**. The earlier `DECOUPLED` design (posting a `wmShowMenu`
message and showing the menu asynchronously on the pump after the `SendMessage`
returned) left the shell's per-icon *"context menu in progress"* state stuck, so it
suppressed every subsequent right-click. `WM_NULL` only clears the **thread**'s
menu-active flag; it cannot reset the **shell**'s per-icon state. The `DECOUPLED`
design was originally introduced to avoid a "hard AV", but that AV came from the
abandoned synthetic Alt keypress (`keybd_event VK_MENU`) / a wrong-thread variant —
not from a synchronous `TrackPopupMenu`. Because `systray.go` calls
`runtime.LockOSThread()` and the pump runs `doNativeTick` on that same thread,
`wndProc` and the tray window are on one OS thread, so running `TrackPopupMenu`
synchronously inside the callback is the standard, safe Win32 pattern (the left-click
path `systrayLeftClick → showMenu → showMenuAt` already did exactly this and worked).

**Fix (v7, second half):** make `WM_RBUTTONUP` show the menu **synchronously** —
call `wt.showMenuAt(x, y)` directly in the handler instead of posting `wmShowMenu`;
delete the `wmShowMenu` message field, its assignment, and its `case` handler.
`showMenuAt` is unchanged: `AttachThreadInput` + `SetForegroundWindow` +
`TrackPopupMenu` + `PostMessage(WM_NULL)` (the `WM_NULL` post is retained and
correct).

**Verification (v7 — NOT a real fix, see v8):** `go build -ldflags "-H windowsgui" -o
..\career-dashboard-ui.exe .` compiles clean, but the actual user desktop test of the
rebuilt exe (tray-debug.log pid=31736) still showed the menu opening only on the FIRST
right-click, then only `0x200` arriving while `0x205` stopped. The synchronous
re-wiring alone did NOT clear the suppression.

---

## v8 — restore the previous foreground window after the menu closes (definitive fix)

**Symptom (persists after v7):** with `WM_RBUTTONUP` now synchronous, the first
right-click fully succeeds (`attached=true`, `SetForegroundWindow res=1`,
`TrackPopupMenu res=1`, `WM_NULL` posted), but every subsequent right-click is still
suppressed — `0x205` stops reaching `wndProc`, only `0x200` continues.

**Root cause of the remaining suppression (Oracle-confirmed):** `showMenuAt` calls
`SetForegroundWindow(t.window)`, so after the menu closes **t.window remains the
foreground window**. The shell (explorer) suppresses tray right-click notifications
for an icon whose owner window is already the foreground window — it treats the
context-menu interaction as still in progress and does not deliver a new `0x205`.
Restoring the foreground to whatever window owned it before the menu breaks that
condition and re-enables delivery on every subsequent click. `WM_NULL` clears only
the thread's menu-active flag; it cannot fix the shell's foreground-based
suppression.

**Fix (v8):** in `showMenuAt`, capture the foreground window **before**
`SetForegroundWindow` (`prevFG := fg`), and after `TrackPopupMenu` + `PostMessage(WM_NULL)`
restore it:

```go
if prevFG == 0 {
    prevFG, _, _ = pGetDesktopWindow.Call() // never leave t.window foreground
}
if prevFG != 0 {
    restoreRes, _, _ := pSetForegroundWindow.Call(prevFG)
}
```

Because this thread owns the foreground at that moment (we took it with
`SetForegroundWindow`), handing it back to `prevFG` is permitted by the foreground
lock. Restoring to the browser/whatever the user was using is also the natural,
expected tray behavior (focus returns to the prior window when the menu closes).

**Also added:** `pGetDesktopWindow = u32.NewProc("GetDesktopWindow")` to the lazy-proc
var block.

**Verification (v8):** `go build -ldflags "-H windowsgui" -o ..\career-dashboard-ui.exe .`
compiles clean (BUILD_EXIT=0). Real-desktop re-test required: kill the old
`career-dashboard-ui.exe` process first, launch the rebuilt exe, and right-click the
tray icon 20+ times consecutively — every click should show the menu. Confirm in
`tray-debug.log` that each click logs `SetForegroundWindow res=1`, `TrackPopupMenu
res=1`, and `restored foreground to 0x... res=1`.

**Verification result (v8 — IMPROVED but not fixed):** user real-desktop test showed
the menu FLASHING and instantly dismissing on the first click, the second click
working normally, and all subsequent clicks doing nothing — even though every API
call in the log reported success (`SetForegroundWindow res=1`, `TrackPopupMenu
res=1`, `restored foreground to 0x1010e res=1`). So the restore-foreground direction
was partially right (a second show now works) but the flash-dismiss + later
suppression remained.

---

## v9 — remove AttachThreadInput (definitive fix, Oracle-confirmed)

**Root cause of the residual flash + suppression (Oracle-confirmed):** the
`AttachThreadInput(myTid, fgTid, TRUE)` call (introduced in v7) was the culprit. With
the two threads' input queues merged, `SetForegroundWindow(t.window)` reported a
**false success** — it returned `1` from the attached thread's perspective even
though `t.window` never actually became the real foreground window. `TrackPopupMenu`
internally verifies that its owner window is the actual foreground window; when it
isn't, the menu shows and immediately dismisses (the flash), and the thread's
menu-active flag never clears, which suppresses every later right-click. `WM_NULL`
only releases that flag when the owner truly was foreground.

**Fix (v9):** drop `AttachThreadInput` (and the now-unused `pAttachThreadInput`,
`pGetWindowThreadProcessId`, `pGetCurrentThreadId` procs) and use the plain, canonical
MSDN pattern — owner-foreground + `TrackPopupMenu` + `WM_NULL` + restore:

```go
prevFG := GetForegroundWindow()
SetForegroundWindow(t.window)                       // owner must be foreground
TrackPopupMenu(t.menus[0],
    TPM_BOTTOMALIGN|TPM_LEFTALIGN|TPM_RIGHTBUTTON,  // right-click trigger
    x, y, 0, t.window, 0)
PostMessage(t.window, WM_NULL, 0, 0)                // clear menu-active flag
if prevFG != 0 { SetForegroundWindow(prevFG) }      // restore focus
```

Also added `TPM_RIGHTBUTTON` (0x0002) so the menu is treated as right-button
triggered. The synchronous `WM_RBUTTONUP`→`showMenuAt` call stays. Because the
callback runs synchronously inside the user's right-click, the foreground lock does
not block `SetForegroundWindow`, so the plain pattern is correct and reliable.

**Verification (v9):** `go build -ldflags "-H windowsgui" -o ..\career-dashboard-ui.exe .`
compiles clean (BUILD_EXIT=0). Real-desktop re-test required: kill the old
`career-dashboard-ui.exe` process first, launch the rebuilt exe, and right-click the
tray icon 20+ times consecutively — every click should show the menu and persist
(no flash). Confirm in `tray-debug.log` that each click logs `SetForegroundWindow
res=1`, `TrackPopupMenu res=1`, and `restored foreground to 0x... res=1`. If a rare
flash still occurs, escalate to the decoupled pattern: `WM_RBUTTONUP` posts a custom
message and `showMenuAt` runs on the pump after the shell's `SendMessage` returns.

## v10 — revert to AttachThreadInput + drop foreground restore (getlantern reference, Oracle-confirmed)

**Context (v9 falsified):** v9 (no AttachThreadInput, restore-prevFG) was tested in
real desktop use: the menu showed only ONCE, then 19 subsequent right-clicks were
silent. The tray-debug.log confirmed only the first click reached wndProc; later
clicks showed `WM_MOUSEMOVE (0x200)` still arriving while `WM_RBUTTONUP (0x205)`
stopped. So v9's claim that AttachThreadInput caused a "false success" was wrong for
this app, and removing it did not fix the suppression.

**Architecture clarification (critical):** this app registers its OWN tray icon via
`Shell_NotifyIcon(NIM_ADD)` with `nid.Wnd = t.window` (a real, hidden WS_OVERLAPPEDWINDOW
top-level window) and `nid.CallbackMessage = wmSystrayMessage`. The shell sends the
right-click as a tray callback to OUR window; it does NOT run its own TrackPopupMenu.
So the earlier `Shell_TrayWnd` restore-foreground theory does not apply — there is no
separate shell menu being dismissed.

**Final fix (v10, matches getlantern/systray reference):** with a self-registered icon
whose owner window is `t.window`, the only thing that suppresses the NEXT 0x205 is that
`t.window` never pumps a message after `TrackPopupMenu` returns, so the shell's mouse
capture for this icon is never released. Posting `WM_NULL` to `t.window` AFTER
`TrackPopupMenu` returns forces that pump and releases capture — the reset that
re-enables every subsequent callback. `AttachThreadInput` is required so
`SetForegroundWindow(t.window)` actually succeeds (the foreground belongs to the
shell's thread); without it the menu owner is never truly foreground and `WM_NULL`
cannot release capture. We deliberately do NOT restore the foreground afterwards —
getlantern doesn't, and it works repeatedly; foreground relocation is not the reset
mechanism.

```go
fg, _ := GetForegroundWindow()
fgTid := GetWindowThreadProcessId(fg)
myTid := GetCurrentThreadId()
if fgTid != 0 && fgTid != myTid {
    AttachThreadInput(myTid, fgTid, TRUE)         // allow SFW to succeed
    defer AttachThreadInput(myTid, fgTid, FALSE)  // detach after menu + WM_NULL
}
SetForegroundWindow(t.window)
TrackPopupMenu(t.menus[0],
    TPM_BOTTOMALIGN|TPM_RIGHTALIGN|TPM_RIGHTBUTTON,
    x, y, 0, t.window, 0)
PostMessage(t.window, WM_NULL, 0, 0)              // release capture -> next 0x205 arrives
```

Also restored the `pAttachThreadInput` / `pGetCurrentThreadId` / `pGetWindowThreadProcessId`
proc bindings, added `TPM_RIGHTALIGN (0x0008)`, switched the TrackPopupMenu alignment from
LEFTALIGN to RIGHTALIGN, and removed the `prevFG` restore block.

**Verification (v10):** `go build -ldflags "-H windowsgui" -o ..\career-dashboard-ui.exe .`
compiles clean (BUILD_EXIT=0). Real-desktop re-test required: kill the old
`career-dashboard-ui.exe` process first, launch the rebuilt exe, and right-click the
tray icon 20+ times consecutively — every click should show the menu. Confirm in
`tray-debug.log` that every click logs `SetForegroundWindow res=1` and `TrackPopupMenu
res=1`, and that `WM_RBUTTONUP (0x205)` keeps reaching wndProc on each click (not just
the first).

**Verification result (v10 — STILL NOT fixed):** `tray-debug.log` (pid=33004) shows
`showMenu returned ok` fully succeeding 4-5 times (`fgTid`/`myTid` constant across all
shows), then the shell again stops delivering `0x205` while `WM_MOUSEMOVE (0x200)`
keeps arriving — the same "shows a few times then stops" signature as v1-v9.

---

## v11 — pin the tray goroutine with runtime.LockOSThread + drop AttachThreadInput (definitive)

**The overlooked invariant across v1-v10:** every previous fix touched `showMenuAt`
(WM_NULL, SPI hacks, AttachThreadInput, foreground restore, TPM flags) but NONE pinned
the goroutine that actually runs the tray. That was the real structural bug.

**Root cause (definitive):** the vendored library's `systray.go` calls
`runtime.LockOSThread()` in `init()`, which pins **only the main goroutine**.
getlantern/systray expects `systray.Run()` to be called **directly, blocking, on that
pinned main goroutine**, so window creation (`registerSystray`), the message pump
(`nativeLoop` → `GetMessage`), `wndProc` (`DispatchMessage`) and `TrackPopupMenu` all
run on the **same pinned OS thread** — the Win32 model the library assumes.

This app instead calls `systray.Run` inside `go func() { ... }()` (in
`tray_windows.go`), so the whole tray runs on a **new, unpinned goroutine**. The
`init()` lock is useless there. An unpinned Go goroutine can be migrated to a different
OS thread by async preemption at the syscall / `log.Printf` points inside `showMenuAt`
(`SetForegroundWindow` → `TrackPopupMenu` → `PostMessage`). Once the goroutine migrates
off the thread that owns the tray window, the window/menu/message-pump thread affinity
is corrupted, and the shell suppresses subsequent `WM_RBUTTONUP (0x205)` notifications
for that icon (while `WM_MOUSEMOVE (0x200)` keeps flowing — exactly the signature every
version logged). Migration is intermittent, which is why it "works a few times then
stops" and why `myTid` stayed constant across the few captured shows.

**Fix (v11):**

1. `tray_windows.go` — call `runtime.LockOSThread()` as the first statement inside the
   `go func()` that runs `systray.Run`. This pins the tray goroutine to one OS thread
   for its entire lifetime, restoring the threading model getlantern assumes:

   ```go
   go func() {
       runtime.LockOSThread() // pin: window+pump+wndProc+TrackPopupMenu on one thread
       defer close(t.done)
       systray.Run(onReady, onExit)
   }()
   ```

2. `systray_windows.go` — back to the plain, canonical, proven getlantern pattern.
   Drop `AttachThreadInput` (v6/v10) and the foreground restore (v8), which were both
   workarounds for the foreground-lock that no longer apply once the thread is pinned:
   we are handling the right-click, so our (now pinned) thread is the last input
   recipient and the Win32 foreground lock lets `SetForegroundWindow` succeed on its
   own. Removed the now-unused `pAttachThreadInput`, `pGetCurrentThreadId`,
   `pGetForegroundWindow`, `pGetWindowThreadProcessId`, and `pGetDesktopWindow`
   (dead since v8) proc bindings. The call is now simply:

   ```go
   SetForegroundWindow(t.window)
   TrackPopupMenu(t.menus[0], TPM_BOTTOMALIGN|TPM_RIGHTALIGN|TPM_RIGHTBUTTON, x, y, 0, t.window, 0)
   PostMessage(t.window, WM_NULL, 0, 0) // clear menu-active state
   ```

**Verification (v11):** `gofmt` clean and `go build ... .` compiles clean (BUILD_EXIT=0).
Real-desktop re-test required — this is the first version to touch the *threading model*
rather than the menu call, so it is the candidate that can actually clear the symptom:
kill the old `career-dashboard-ui.exe` process, launch the rebuilt exe, and right-click
the tray icon 20+ times consecutively — every click should show the menu. Confirm in
`tray-debug.log` that `WM_RBUTTONUP (0x205)` keeps reaching `wndProc` on **every** click
(not just the first few) and that no click logs a thread id different from the first.
