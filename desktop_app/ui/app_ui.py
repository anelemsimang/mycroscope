"""Agent UI: one tkinter window (sign-in, notice, 'My activity') plus a tray icon.

Background threads never touch tkinter directly; they post callables to
`self._queue`, which the Tk thread drains every 100 ms.
"""

import queue
import threading
import tkinter as tk
from tkinter import messagebox, simpledialog, ttk
from tkinter.scrolledtext import ScrolledText
from typing import Any, Callable, Optional

from PIL import Image, ImageDraw
import pystray

from config import APP_NAME, THEME_COLORS as C, VERSION
from core.agent import Agent
from core.api import ApiError, AuthError, NetworkError
from utils.logger import get_logger

log = get_logger("ui")

STATE_LABELS = {
    "active": ("Active", C["success"]),
    "idle": ("Idle", C["warning"]),
    "away": ("Away (locked or asleep)", C["text_secondary"]),
    "paused": ("Tracking paused", C["warning"]),
    "logged_out": ("Not tracking", C["text_secondary"]),
}


def _fmt(seconds: int) -> str:
    h, m = divmod(int(seconds) // 60, 60)
    return f"{h}h {m:02d}m"


def _error_text(exc: Exception) -> str:
    if isinstance(exc, NetworkError):
        return "Can't reach the Mycroscope server. Check your internet connection and try again."
    if isinstance(exc, ApiError):
        return exc.message
    return str(exc) or exc.__class__.__name__


def _tray_image(color: str) -> Image.Image:
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse((2, 2, 62, 62), fill=C["primary"])
    d.ellipse((38, 38, 62, 62), fill=color, outline="white", width=3)
    d.text((17, 14), "M", fill="white", font_size=30)
    return img


class AgentApp:
    def __init__(self, start_hidden: bool = False):
        self.start_hidden = start_hidden
        self._queue: "queue.Queue[Callable[[], None]]" = queue.Queue()
        self.root = tk.Tk()
        self.root.title(APP_NAME)
        self.root.geometry("460x640")
        self.root.minsize(420, 560)
        self.root.configure(bg=C["background"])
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self.root.protocol("WM_SAVE_YOURSELF", self._on_session_end)
        self._style()
        self.agent = Agent(on_change=lambda kind: self.post(lambda: self._on_agent_change(kind)))
        self.frame: Optional[tk.Frame] = None
        self.status_widgets: dict[str, Any] = {}
        self.tray: Optional[pystray.Icon] = None
        self._tray_color = None

    # ---- plumbing --------------------------------------------------------
    def post(self, fn: Callable[[], None]) -> None:
        self._queue.put(fn)

    def _pump(self) -> None:
        try:
            while True:
                self._queue.get_nowait()()
        except queue.Empty:
            pass
        except Exception:
            log.exception("UI callback failed")
        self.root.after(100, self._pump)

    def run_bg(self, fn: Callable[[], Any], on_ok: Callable[[Any], None],
               on_err: Optional[Callable[[Exception], None]] = None) -> None:
        def worker():
            try:
                result = fn()
            except Exception as exc:  # noqa: BLE001 - reported to the user
                if not isinstance(exc, (AuthError, NetworkError, ApiError, RuntimeError)):
                    log.exception("Background task failed")
                self.post(lambda: (on_err or self._show_error)(exc))
                return
            self.post(lambda: on_ok(result))
        threading.Thread(target=worker, daemon=True).start()

    def _show_error(self, exc: Exception) -> None:
        messagebox.showerror(APP_NAME, _error_text(exc), parent=self.root)

    def _style(self) -> None:
        s = ttk.Style(self.root)
        s.theme_use("clam")
        s.configure(".", background=C["background"], foreground=C["text"], font=("Segoe UI", 10))
        s.configure("TFrame", background=C["background"])
        s.configure("TLabel", background=C["background"])
        s.configure("Title.TLabel", font=("Segoe UI", 16, "bold"), foreground=C["primary"])
        s.configure("Sub.TLabel", foreground=C["text_secondary"])
        s.configure("Big.TLabel", font=("Segoe UI", 14, "bold"))
        s.configure("TButton", padding=6)
        s.configure("Primary.TButton", background=C["primary"], foreground="white")
        s.map("Primary.TButton", background=[("active", "#1e40af"), ("disabled", "#9ca3af")])
        s.configure("TCheckbutton", background=C["background"])
        s.configure("TNotebook", background=C["background"])

    def _swap(self) -> tk.Frame:
        if self.frame is not None:
            self.frame.destroy()
        self.status_widgets = {}
        self.frame = ttk.Frame(self.root, padding=20)
        self.frame.pack(fill="both", expand=True)
        return self.frame

    def show_window(self) -> None:
        self.root.deiconify()
        self.root.lift()
        self.root.focus_force()

    # ---- start -----------------------------------------------------------
    def run(self) -> None:
        self.root.after(100, self._pump)
        self._start_tray()
        if self.start_hidden:
            self.root.withdraw()
        self._show_message("Starting…")
        self._restore()
        self.root.mainloop()

    def _restore(self) -> None:
        def on_ok(restored: bool):
            if restored:
                self._after_sign_in()
            else:
                self.show_login()

        def on_err(exc: Exception):
            if isinstance(exc, NetworkError):
                self._show_message("Waiting for the network…\nMycroscope will connect automatically.")
                self.root.after(15000, self._restore)
            else:
                self.show_login()

        self.run_bg(self.agent.try_restore, on_ok, on_err)

    def _show_message(self, text: str) -> None:
        f = self._swap()
        ttk.Label(f, text=APP_NAME, style="Title.TLabel").pack(pady=(60, 10))
        ttk.Label(f, text=text, style="Sub.TLabel", justify="center").pack()

    # ---- sign in ---------------------------------------------------------
    def show_login(self, message: str = "") -> None:
        self.show_window()
        f = self._swap()
        ttk.Label(f, text=APP_NAME, style="Title.TLabel").pack(anchor="w")
        ttk.Label(f, text="Employee activity agent", style="Sub.TLabel").pack(anchor="w", pady=(0, 10))
        if message:
            ttk.Label(f, text=message, foreground=C["alert"], wraplength=400).pack(anchor="w", pady=(0, 8))

        nb = ttk.Notebook(f)
        nb.pack(fill="both", expand=True)
        nb.add(self._sign_in_tab(nb), text="Sign in")
        nb.add(self._activate_tab(nb), text="Activate account")

    def _field(self, parent, label: str, show: str = "") -> ttk.Entry:
        ttk.Label(parent, text=label).pack(anchor="w", pady=(8, 2))
        e = ttk.Entry(parent, show=show, width=40)
        e.pack(fill="x")
        return e

    def _sign_in_tab(self, nb) -> ttk.Frame:
        t = ttk.Frame(nb, padding=12)
        ident = self._field(t, "Email or employee code")
        pw = self._field(t, "Password", show="•")
        btn = ttk.Button(t, text="Sign in", style="Primary.TButton")
        btn.pack(fill="x", pady=(16, 6))

        def submit(_=None):
            if not ident.get().strip() or not pw.get():
                return
            btn.state(["disabled"])
            self.run_bg(lambda: self.agent.sign_in(ident.get(), pw.get()),
                        lambda _: self._after_sign_in(),
                        lambda exc: (btn.state(["!disabled"]), self._show_error(exc)))

        def forgot():
            if not ident.get().strip():
                messagebox.showinfo(APP_NAME, "Enter your email or employee code first.", parent=self.root)
                return
            self.run_bg(lambda: self.agent.request_password_reset(ident.get()),
                        lambda _: messagebox.showinfo(
                            APP_NAME, "If that account exists, a password reset email has been sent.",
                            parent=self.root))

        btn.configure(command=submit)
        pw.bind("<Return>", submit)
        ttk.Button(t, text="Forgot password?", command=forgot).pack(anchor="e")
        ident.focus_set()
        return t

    def _activate_tab(self, nb) -> ttk.Frame:
        t = ttk.Frame(nb, padding=12)
        ttk.Label(t, text="First time? Use the employee code and activation code from your manager.",
                  style="Sub.TLabel", wraplength=380).pack(anchor="w")
        code = self._field(t, "Employee code")
        act = self._field(t, "Activation code")
        email = self._field(t, "Your work email")
        pw = self._field(t, "Choose a password (min. 8 characters)", show="•")
        pw2 = self._field(t, "Confirm password", show="•")
        btn = ttk.Button(t, text="Activate and sign in", style="Primary.TButton")
        btn.pack(fill="x", pady=(16, 0))

        def submit():
            if not all(x.get().strip() for x in (code, act, email, pw)):
                messagebox.showwarning(APP_NAME, "Please fill in every field.", parent=self.root)
                return
            if len(pw.get()) < 8:
                messagebox.showwarning(APP_NAME, "The password must be at least 8 characters.", parent=self.root)
                return
            if pw.get() != pw2.get():
                messagebox.showwarning(APP_NAME, "The passwords don't match.", parent=self.root)
                return
            btn.state(["disabled"])
            self.run_bg(lambda: self.agent.activate(code.get(), act.get(), email.get(), pw.get()),
                        lambda _: self._after_sign_in(),
                        lambda exc: (btn.state(["!disabled"]), self._show_error(exc)))

        btn.configure(command=submit)
        return t

    def _after_sign_in(self) -> None:
        def on_ok(policy):
            if policy is None:
                self.show_login("Your organisation has not published a monitoring notice yet. "
                                "Ask your manager, then sign in again.")
                self.run_bg(self.agent.sign_out, lambda _: None)
            elif self.agent.needs_acknowledgement:
                self.show_notice(mode="initial")
            else:
                self._start_tracking()

        self.run_bg(self.agent.fetch_policy, on_ok,
                    lambda exc: (self._show_error(exc), self.show_login()))

    # ---- monitoring notice -----------------------------------------------
    def show_notice(self, mode: str) -> None:
        """mode: initial (must acknowledge before tracking), update (new version while tracking), view."""
        self.show_window()
        policy = self.agent.policy or {}
        f = self._swap()
        heading = {
            "initial": "Workplace monitoring notice",
            "update": "The monitoring notice has changed",
            "view": "Workplace monitoring notice",
        }[mode]
        ttk.Label(f, text=heading, style="Title.TLabel").pack(anchor="w")
        ttk.Label(f, text=f"Version {policy.get('version', '?')} · {self.agent.profile.organization_name}",
                  style="Sub.TLabel").pack(anchor="w", pady=(0, 8))
        box = ScrolledText(f, wrap="word", height=18, font=("Segoe UI", 10), relief="solid", borderwidth=1)
        box.insert("1.0", policy.get("notice_text") or "")
        box.configure(state="disabled")
        box.pack(fill="both", expand=True)

        buttons = ttk.Frame(f)
        buttons.pack(fill="x", pady=(10, 0))
        if mode == "view" and not self.agent.needs_acknowledgement:
            ack_at = policy.get("acknowledged_at") or ""
            ttk.Label(f, text=f"You acknowledged this notice on {ack_at[:16].replace('T', ' ')} (UTC).",
                      style="Sub.TLabel").pack(anchor="w", pady=(6, 0))
            ttk.Button(buttons, text="Back", command=self.show_status).pack(side="right")
            return

        agreed = tk.BooleanVar(value=False)
        ttk.Checkbutton(f, text="I have read and understood this notice.", variable=agreed,
                        command=lambda: ack.state(["!disabled"] if agreed.get() else ["disabled"])).pack(
            anchor="w", pady=(8, 0))
        ack = ttk.Button(buttons, text="Acknowledge" + (" and start" if mode == "initial" else ""),
                         style="Primary.TButton")
        ack.state(["disabled"])
        ack.pack(side="right")
        if mode == "initial":
            ttk.Button(buttons, text="Sign out", command=self._sign_out).pack(side="left")
        else:
            ttk.Button(buttons, text="Later", command=self.show_status).pack(side="left")

        def submit():
            ack.state(["disabled"])
            self.run_bg(self.agent.acknowledge_policy,
                        lambda _: self._start_tracking() if mode == "initial" else self.show_status(),
                        lambda exc: (ack.state(["!disabled"]), self._show_error(exc)))

        ack.configure(command=submit)

    # ---- tracking / status -----------------------------------------------
    def _start_tracking(self) -> None:
        def on_ok(_):
            self.show_status()
            if self.start_hidden:
                self.root.withdraw()
                self.start_hidden = False
        self.run_bg(self.agent.start_tracking, on_ok)

    def show_status(self) -> None:
        f = self._swap()
        p = self.agent.profile
        w = self.status_widgets
        ttk.Label(f, text=p.name, style="Title.TLabel").pack(anchor="w")
        ttk.Label(f, text=f"{p.organization_name} · {p.employee_code}", style="Sub.TLabel").pack(anchor="w")

        w["state"] = ttk.Label(f, text="", style="Big.TLabel")
        w["state"].pack(anchor="w", pady=(16, 0))
        w["current"] = ttk.Label(f, text="", style="Sub.TLabel", wraplength=410)
        w["current"].pack(anchor="w")

        today = ttk.LabelFrame(f, text="Today", padding=10)
        today.pack(fill="x", pady=(14, 0))
        for i, key in enumerate(("active", "idle", "away", "paused")):
            ttk.Label(today, text=key.capitalize()).grid(row=0, column=i, padx=8)
            w[f"t_{key}"] = ttk.Label(today, text="0h 00m", font=("Segoe UI", 11, "bold"))
            w[f"t_{key}"].grid(row=1, column=i, padx=8)

        proj = ttk.LabelFrame(f, text="Project", padding=10)
        proj.pack(fill="x", pady=(12, 0))
        w["project"] = ttk.Combobox(proj, state="readonly", width=30)
        w["project"].pack(side="left", fill="x", expand=True)
        w["project"].bind("<<ComboboxSelected>>", self._on_project_selected)
        ttk.Button(proj, text="New…", command=self._new_project).pack(side="left", padx=(8, 0))
        self._fill_projects()

        w["pause"] = ttk.Button(f, command=self._toggle_pause)
        w["pause"].pack(fill="x", pady=(12, 0))

        w["sync"] = ttk.Label(f, text="", style="Sub.TLabel")
        w["sync"].pack(anchor="w", pady=(12, 0))

        w["tracked"] = ttk.Label(f, text="", style="Sub.TLabel", wraplength=410, justify="left")
        w["tracked"].pack(anchor="w", pady=(6, 0))

        bottom = ttk.Frame(f)
        bottom.pack(side="bottom", fill="x")
        ttk.Button(bottom, text="Monitoring notice", command=lambda: self.show_notice("view")).pack(side="left")
        ttk.Button(bottom, text="Sign out", command=self._sign_out).pack(side="right")
        ttk.Label(f, text=f"v{VERSION} · closing this window keeps tracking in the tray",
                  style="Sub.TLabel").pack(side="bottom", anchor="w", pady=(0, 6))
        self._refresh_status()

    def _tracked_description(self) -> str:
        s = self.agent.settings
        items = ["active, idle and away time"]
        if s.track_apps:
            items.append("which application is in use")
        if s.track_window_titles:
            items.append("window titles")
        if s.track_full_urls and s.track_web_domains:
            items.append("full website addresses")
        elif s.track_web_domains:
            items.append("website domains")
        return ("While you are signed in, Mycroscope records " + ", ".join(items) +
                ". Your manager can see this. It never records keystrokes, screenshots or file contents.")

    def _refresh_status(self) -> None:
        w = self.status_widgets
        if not w or not self.agent.profile:
            return
        live = self.agent.live_status()
        state = live.get("state", "logged_out")
        label, color = STATE_LABELS.get(state, (state, C["text"]))
        w["state"].configure(text=label, foreground=color)
        current = ""
        if state == "active":
            parts = [x for x in (live.get("app_name"), live.get("domain")) if x]
            current = " — ".join(parts)
        w["current"].configure(text=current)
        for key, value in self.agent.today_totals().items():
            if f"t_{key}" in w:
                w[f"t_{key}"].configure(text=_fmt(value))
        allowed = self.agent.settings.allow_pause
        w["pause"].configure(text="Resume tracking" if self.agent.paused else
                             ("Pause tracking" if allowed else "Pausing is disabled by your organisation"))
        w["pause"].state(["!disabled"] if (allowed or self.agent.paused) and self.agent.tracking else ["disabled"])
        pending = self.agent.pending_uploads()
        online = self.agent.online
        if online is False:
            sync = f"Offline — {pending} item(s) saved on this PC, will upload automatically"
        elif pending > 2:
            sync = f"Uploading… {pending} item(s) waiting"
        else:
            sync = "Connected · data up to date"
        w["sync"].configure(text=sync)
        w["tracked"].configure(text=self._tracked_description())
        self._update_tray(state)
        self.root.after(2000, self._refresh_status)

    def _fill_projects(self) -> None:
        box = self.status_widgets.get("project")
        if not box:
            return
        names = ["(No project)"] + [p["name"] for p in self.agent.projects]
        box.configure(values=names)
        current = next((p["name"] for p in self.agent.projects if p["id"] == self.agent.project_id), "(No project)")
        box.set(current)

    def _on_project_selected(self, _=None) -> None:
        name = self.status_widgets["project"].get()
        pid = next((p["id"] for p in self.agent.projects if p["name"] == name), None)
        self.agent.set_project(pid)

    def _new_project(self) -> None:
        name = simpledialog.askstring(APP_NAME, "New project name:", parent=self.root)
        if not name or not name.strip():
            return

        def on_ok(pid):
            self.agent.set_project(pid)
            self._fill_projects()
        self.run_bg(lambda: self.agent.create_project(name), on_ok)

    def _toggle_pause(self) -> None:
        try:
            self.agent.set_paused(not self.agent.paused)
        except RuntimeError as exc:
            self._show_error(exc)

    def _sign_out(self) -> None:
        if not messagebox.askyesno(APP_NAME, "Sign out and stop tracking on this PC?", parent=self.root):
            return
        self._show_message("Signing out…")
        self.run_bg(self.agent.sign_out, lambda _: self.show_login(),
                    lambda exc: (log.warning("Sign-out problem: %s", exc), self.show_login()))

    # ---- agent callbacks -------------------------------------------------
    def _on_agent_change(self, kind: str) -> None:
        if kind == "auth_lost":
            self.show_login("You were signed out: " + (self.agent.auth_lost_message or "session expired") +
                            "\nSign in again to resume tracking.")
        elif kind == "policy" and self.agent.tracking and self.agent.needs_acknowledgement:
            self.show_notice(mode="update")
            self._notify("The monitoring notice has changed. Please review it.")
        elif kind == "projects":
            self._fill_projects()
        elif kind == "state":
            self._update_tray(self.agent.live_status().get("state", "logged_out"))

    # ---- tray ------------------------------------------------------------
    def _start_tray(self) -> None:
        menu = pystray.Menu(
            pystray.MenuItem("Open Mycroscope", lambda: self.post(self.show_window), default=True),
            pystray.MenuItem(lambda _: "Resume tracking" if self.agent.paused else "Pause tracking",
                             lambda: self.post(self._toggle_pause),
                             enabled=lambda _: self.agent.tracking and
                             (self.agent.settings.allow_pause or self.agent.paused)),
            pystray.MenuItem("Sign out", lambda: self.post(lambda: (self.show_window(), self._sign_out())),
                             enabled=lambda _: self.agent.tracking),
        )
        self.tray = pystray.Icon(APP_NAME, _tray_image(C["text_secondary"]), APP_NAME, menu)
        self.tray.run_detached()

    def _update_tray(self, state: str) -> None:
        if not self.tray:
            return
        label, color = STATE_LABELS.get(state, (state, C["text_secondary"]))
        if color != self._tray_color:
            self.tray.icon = _tray_image(color)
            self._tray_color = color
        self.tray.title = f"{APP_NAME} — {label}"
        self.tray.update_menu()

    def _notify(self, message: str) -> None:
        try:
            self.tray.notify(message, APP_NAME)
        except Exception:
            pass

    # ---- window / exit ---------------------------------------------------
    def _on_close(self) -> None:
        if self.agent.tracking:
            self.root.withdraw()
            self._notify("Mycroscope is still tracking. Use the tray icon to open it or sign out.")
        else:
            self._quit()

    def _on_session_end(self) -> None:
        log.info("Windows session ending")
        self._quit()

    def _quit(self) -> None:
        try:
            self.agent.shutdown()
        finally:
            if self.tray:
                self.tray.stop()
            self.root.destroy()
