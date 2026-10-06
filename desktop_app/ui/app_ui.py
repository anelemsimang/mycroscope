"""Agent UI: one tkinter window (sign-in, notice, 'My activity') plus a tray icon.

Background threads never touch tkinter directly; they post callables to
`self._queue`, which the Tk thread drains every 100 ms.
"""

import ctypes
import queue
import sys
import threading
import time
import tkinter as tk
from tkinter import ttk
from pathlib import Path
from typing import Any, Callable, Optional

from PIL import Image, ImageDraw
import pystray

from config import (APP_NAME, IN_USE_IDLE_SECONDS, REMINDER_INTERVAL_SECONDS, THEME_COLORS as C,
                    UNATTENDED_ALERT_MINUTES, UNATTENDED_REPORT_SECONDS, VERSION)
from core.agent import Agent
from core.api import ApiError, AuthError, NetworkError
from core.unattended import UnattendedWatch
from ui import theme
from ui.theme import P
from utils.autostart import mark_stopped_by_user
from utils.logger import get_logger

log = get_logger("ui")

STATE_LABELS = {
    "active": ("Active", C["success"]),
    "idle": ("Idle", C["warning"]),
    "away": ("Away (locked or asleep)", C["text_secondary"]),
    "paused": ("Tracking paused", C["warning"]),
    "off_hours": ("Outside working hours — not recording", C["text_secondary"]),
    "inactive": ("Not recording — your organisation's subscription is inactive", C["text_secondary"]),
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


def _asset(name: str) -> Path:
    # PyInstaller unpacks bundled data under sys._MEIPASS; from source it sits next to the code.
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
    return base / "assets" / name


def _logo(size: int) -> Image.Image:
    try:
        return Image.open(_asset("mycroscope.png")).convert("RGBA").resize((size, size), Image.LANCZOS)
    except OSError:
        log.warning("Logo image missing; using a plain icon")
        img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        ImageDraw.Draw(img).rounded_rectangle((0, 0, size - 1, size - 1), radius=size // 5, fill=C["primary"])
        return img


def _tray_image(color: str) -> Image.Image:
    """The logo with a status dot in the corner (the dot colour follows the tracking state)."""
    img = _logo(64)
    ImageDraw.Draw(img).ellipse((40, 40, 63, 63), fill=color, outline="white", width=3)
    return img


def _set_app_id() -> None:
    # Gives the window its own taskbar entry and icon instead of python.exe's when run from source.
    if sys.platform == "win32":
        try:
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("Mycroscope.Agent")
        except (AttributeError, OSError):
            pass


class AgentApp:
    def __init__(self, start_hidden: bool = False):
        self.start_hidden = start_hidden
        self._queue: "queue.Queue[Callable[[], None]]" = queue.Queue()
        _set_app_id()
        theme.prepare_process(_asset("fonts"))
        self.root = tk.Tk()
        self.root.title(APP_NAME)
        self._set_window_icon()
        self.theme = theme.Theme(self.root)
        px = self.theme.px
        self.root.geometry(f"{px(470)}x{px(680)}")
        self.root.minsize(px(430), px(600))
        self.root.configure(bg=P["page"])
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)
        self.root.protocol("WM_SAVE_YOURSELF", self._on_session_end)
        self.theme.apply()
        self._build_header()
        self.agent = Agent(on_change=lambda kind: self.post(lambda: self._on_agent_change(kind)))
        self.frame: Optional[tk.Frame] = None
        self.status_widgets: dict[str, Any] = {}
        self.tray: Optional[pystray.Icon] = None
        self._tray_color = None
        self._closed = False
        self._watch = UnattendedWatch(REMINDER_INTERVAL_SECONDS, UNATTENDED_ALERT_MINUTES,
                                      UNATTENDED_REPORT_SECONDS, IN_USE_IDLE_SECONDS)
        self._watch.reset(time.monotonic())
        self._on_top = False

    def _set_window_icon(self) -> None:
        # The .ico holds 16-256 px. Don't add iconphoto: on Windows it makes the taskbar fall back to python.exe's icon.
        try:
            self.root.iconbitmap(default=str(_asset("mycroscope.ico")))
        except tk.TclError:
            log.warning("Window icon missing")

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
        title = ("Can't connect" if isinstance(exc, NetworkError) else
                 "Sign-in problem" if isinstance(exc, AuthError) else "Something went wrong")
        self._message("error", title, _error_text(exc))

    # ---- layout helpers --------------------------------------------------
    def _build_header(self) -> None:
        px = self.theme.px
        bar = tk.Frame(self.root, bg=P["navy"], height=px(60))
        bar.pack(side="top", fill="x")
        bar.pack_propagate(False)
        self._logo = self.theme.image(_asset("logo-reverse.png"), 28)
        if self._logo:
            tk.Label(bar, image=self._logo, bg=P["navy"], bd=0).pack(side="left", padx=px(20))
        else:
            tk.Label(bar, text=APP_NAME, bg=P["navy"], fg="white", font=self.theme.font["h2"]).pack(
                side="left", padx=px(20))
        self.header_status = tk.Label(bar, text="", bg=P["navy"], fg="#DBEAFE", font=self.theme.font["small"],
                                      compound="left", padx=px(6), bd=0)
        self.header_status.pack(side="right", padx=px(16))
        tk.Frame(self.root, bg=P["cyan"], height=px(3)).pack(side="top", fill="x")

    def _set_header_status(self, text: str, color: Optional[str] = None) -> None:
        image = self.theme.dot(color, 8, P["navy"]) if color else ""
        self.header_status.configure(text=text, image=image)

    def _swap(self) -> ttk.Frame:
        if self.frame is not None:
            self.frame.destroy()
        self.status_widgets = {}
        self.frame = ttk.Frame(self.root, style="Page.TFrame", padding=self.theme.px(18))
        self.frame.pack(fill="both", expand=True)
        return self.frame

    def _card(self, parent, expand: bool = False, pady=(0, 0)) -> ttk.Frame:
        card = self.theme.frame(parent, "Card.TFrame")
        card.pack(fill="both" if expand else "x", expand=expand, pady=pady)
        return card

    def _field(self, parent, label: str, show: str = "") -> ttk.Entry:
        px = self.theme.px
        ttk.Label(parent, text=label, style="Field.TLabel").pack(anchor="w", pady=(px(10), px(4)))
        e = ttk.Entry(parent, show=show, font=self.theme.font["body"])
        e.pack(fill="x")
        return e

    def _banner(self, parent, text: str) -> None:
        box = self.theme.frame(parent, "Danger.TFrame")
        box.pack(fill="x", pady=(0, self.theme.px(12)))
        ttk.Label(box, text=text, style="Danger.TLabel", wraplength=self.theme.px(360), justify="left").pack(anchor="w")

    # ---- dialogs ---------------------------------------------------------
    def _modal(self) -> tuple[tk.Toplevel, ttk.Frame, dict]:
        dlg = tk.Toplevel(self.root)
        dlg.withdraw()
        dlg.title(APP_NAME)
        dlg.configure(bg=P["card"])
        dlg.resizable(False, False)
        dlg.transient(self.root)
        body = ttk.Frame(dlg, padding=self.theme.px(22))
        body.pack(fill="both", expand=True)
        return dlg, body, {"value": None}

    def _run_modal(self, dlg: tk.Toplevel, result: dict, focus: tk.Widget) -> Any:
        if self.root.state() in ("iconic", "withdrawn"):
            self.show_window()
        dlg.update_idletasks()
        x = self.root.winfo_rootx() + (self.root.winfo_width() - dlg.winfo_reqwidth()) // 2
        y = self.root.winfo_rooty() + self.theme.px(150)
        dlg.geometry(f"+{max(x, 0)}+{max(y, 0)}")
        dlg.deiconify()
        if self._on_top:
            dlg.attributes("-topmost", True)
        dlg.lift()
        focus.focus_set()
        try:
            dlg.grab_set()
        except tk.TclError:
            pass
        self.root.wait_window(dlg)
        return result["value"]

    def _message(self, kind: str, title: str, text: str,
                 buttons: tuple = (("OK", True, "Primary.TButton"),)) -> Any:
        """Themed message box. buttons: (label, value, style), left to right; the last is the default."""
        px = self.theme.px
        dlg, body, result = self._modal()

        def done(value: Any) -> None:
            result["value"] = value
            dlg.destroy()

        top = ttk.Frame(body)
        top.pack(fill="x")
        ttk.Label(top, image=self.theme.badge(kind, _asset("fonts") / "Poppins-SemiBold.ttf")).pack(
            side="left", anchor="n", padx=(0, px(14)))
        texts = ttk.Frame(top)
        texts.pack(side="left", fill="x", expand=True)
        ttk.Label(texts, text=title, style="H2.TLabel").pack(anchor="w")
        ttk.Label(texts, text=text, wraplength=px(300), justify="left", foreground=P["text_soft"]).pack(
            anchor="w", pady=(px(4), 0))

        row = ttk.Frame(body)
        row.pack(fill="x", pady=(px(20), 0))
        widgets = []
        for label, value, style in reversed(buttons):
            b = ttk.Button(row, text=label, style=style, command=lambda v=value: done(v))
            b.pack(side="right", padx=(px(8), 0))
            widgets.append(b)
        default_value, cancel_value = buttons[-1][1], buttons[0][1] if len(buttons) > 1 else buttons[-1][1]
        dlg.bind("<Return>", lambda _: done(default_value))
        dlg.bind("<Escape>", lambda _: done(cancel_value))
        dlg.protocol("WM_DELETE_WINDOW", lambda: done(cancel_value))
        return self._run_modal(dlg, result, widgets[0])

    def _confirm(self, title: str, text: str, yes: str, danger: bool = False) -> bool:
        return bool(self._message("question", title, text, (
            ("Cancel", False, "TButton"), (yes, True, "Danger.TButton" if danger else "Primary.TButton"))))

    def _ask_text(self, title: str, prompt: str) -> Optional[str]:
        px = self.theme.px
        dlg, body, result = self._modal()
        ttk.Label(body, text=title, style="H2.TLabel").pack(anchor="w")
        entry = self._field(body, prompt)
        entry.configure(width=34)

        def done(value: Optional[str]) -> None:
            result["value"] = value
            dlg.destroy()

        row = ttk.Frame(body)
        row.pack(fill="x", pady=(px(18), 0))
        ttk.Button(row, text="Create", style="Primary.TButton", command=lambda: done(entry.get())).pack(side="right")
        ttk.Button(row, text="Cancel", command=lambda: done(None)).pack(side="right", padx=(0, px(8)))
        entry.bind("<Return>", lambda _: done(entry.get()))
        dlg.bind("<Escape>", lambda _: done(None))
        return self._run_modal(dlg, result, entry)

    def show_window(self) -> None:
        self.root.deiconify()
        self.root.lift()
        self.root.focus_force()

    # ---- sign-in reminder ------------------------------------------------
    def _watch_tick(self) -> None:
        """While nothing is tracked and someone uses the PC: keep the window on top, then tell the managers."""
        if self._closed:
            return
        try:
            now = time.monotonic()
            if self.agent.tracking:
                self._watch.reset(now)
                self._set_on_top(False)
            else:
                from core import monitor
                decision = self._watch.observe(now, monitor.idle_seconds(), monitor.screen_locked())
                if decision.remind:
                    self._set_on_top(True)
                    self.show_window()
                if decision.report_minutes:
                    threading.Thread(target=self.agent.report_unattended_use, args=(decision.report_minutes,),
                                     daemon=True).start()
        except Exception:
            log.exception("Sign-in reminder check failed")
        self.root.after(5000, self._watch_tick)

    def _set_on_top(self, on_top: bool) -> None:
        self._on_top = on_top
        if bool(self.root.attributes("-topmost")) != on_top:
            self.root.attributes("-topmost", on_top)

    # ---- start -----------------------------------------------------------
    def run(self) -> None:
        self.root.after(100, self._pump)
        self._start_tray()
        if self.start_hidden:
            self.root.iconify()
        self._show_message("Starting…")
        self._restore()
        self.root.after(5000, self._watch_tick)
        try:
            self.root.mainloop()
        except KeyboardInterrupt:
            log.warning("Interrupted (Ctrl+C); shutting down")
        except BaseException:
            log.critical("UI loop crashed; shutting down", exc_info=True)
            raise
        finally:
            self._shutdown(user_requested=False)

    def _shutdown(self, user_requested: bool) -> None:
        """Close the tracking session and the tray icon exactly once, however the app ends."""
        if self._closed:
            return
        self._closed = True
        if user_requested:
            mark_stopped_by_user()
        try:
            self.agent.shutdown()
        except Exception:
            log.exception("Shutdown problem")
        finally:
            if self.tray:
                try:
                    self.tray.stop()
                except Exception:
                    log.exception("Tray stop problem")

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
        px = self.theme.px
        title, _, detail = text.partition("\n")
        self._set_header_status("")
        f = self._swap()
        card = self._card(f, expand=True)
        inner = ttk.Frame(card)
        inner.place(relx=0.5, rely=0.42, anchor="center")
        self._spinner_logo = self.theme.image(_asset("mycroscope.png"), 64)
        if self._spinner_logo:
            ttk.Label(inner, image=self._spinner_logo).pack(pady=(0, px(18)))
        ttk.Label(inner, text=title, style="H2.TLabel").pack()
        if detail:
            ttk.Label(inner, text=detail, style="Muted.TLabel", justify="center").pack(pady=(px(4), 0))
        bar = ttk.Progressbar(inner, mode="indeterminate", length=px(180))
        bar.pack(pady=(px(18), 0))
        bar.start(12)

    # ---- sign in ---------------------------------------------------------
    def show_login(self, message: str = "") -> None:
        px = self.theme.px
        self.show_window()
        self._set_header_status("Not signed in", P["faint"])
        f = self._swap()
        ttk.Label(f, text="Welcome", style="PageH1.TLabel").pack(anchor="w")
        ttk.Label(f, text="Sign in to start your work session on this PC.", style="PageMuted.TLabel").pack(
            anchor="w", pady=(0, px(14)))
        card = self._card(f)
        if message:
            self._banner(card, message)

        track = self.theme.frame(card, "Track.TFrame")
        track.pack(fill="x")
        content = ttk.Frame(card)
        content.pack(fill="x")
        tabs: dict[str, ttk.Button] = {}

        def show_tab(name: str) -> None:
            for key, b in tabs.items():
                b.configure(style="SegOn.TButton" if key == name else "SegOff.TButton")
            for child in content.winfo_children():
                child.destroy()
            (self._sign_in_form if name == "sign_in" else self._activate_form)(content)

        for key, label in (("sign_in", "Sign in"), ("activate", "Activate account")):
            tabs[key] = ttk.Button(track, text=label, command=lambda k=key: show_tab(k))
            tabs[key].pack(side="left", fill="x", expand=True)
        show_tab("sign_in")

    def _sign_in_form(self, t: ttk.Frame) -> None:
        px = self.theme.px
        ident = self._field(t, "Email or employee code")
        pw = self._field(t, "Password", show="•")
        btn = ttk.Button(t, text="Sign in", style="Primary.TButton")
        btn.pack(fill="x", pady=(px(20), px(6)))

        def submit(_=None):
            if not ident.get().strip() or not pw.get():
                return
            btn.state(["disabled"])
            self.run_bg(lambda: self.agent.sign_in(ident.get(), pw.get()),
                        lambda _: self._after_sign_in(),
                        lambda exc: (btn.state(["!disabled"]), self._show_error(exc)))

        def forgot():
            if not ident.get().strip():
                self._message("info", "Who are you?", "Enter your email or employee code first, then tap "
                                                      "\"Forgot password?\" again.")
                return
            self.run_bg(lambda: self.agent.request_password_reset(ident.get()),
                        lambda _: self._message(
                            "info", "Check your email",
                            "If that account exists, we've sent a link to reset your password."))

        btn.configure(command=submit)
        pw.bind("<Return>", submit)
        ident.bind("<Return>", lambda _: pw.focus_set())
        ttk.Button(t, text="Forgot password?", style="Link.TButton", command=forgot).pack(anchor="e")
        ident.focus_set()

    def _activate_form(self, t: ttk.Frame) -> None:
        px = self.theme.px
        ttk.Label(t, text="First time here? Use the employee code and activation code from your manager.",
                  style="Muted.TLabel", wraplength=px(360), justify="left").pack(anchor="w", pady=(px(12), 0))
        codes = ttk.Frame(t)
        codes.pack(fill="x")
        left, right = ttk.Frame(codes), ttk.Frame(codes)
        left.pack(side="left", fill="x", expand=True, padx=(0, px(6)))
        right.pack(side="left", fill="x", expand=True, padx=(px(6), 0))
        code = self._field(left, "Employee code")
        act = self._field(right, "Activation code")
        email = self._field(t, "Your work email")
        pws = ttk.Frame(t)
        pws.pack(fill="x")
        left, right = ttk.Frame(pws), ttk.Frame(pws)
        left.pack(side="left", fill="x", expand=True, padx=(0, px(6)))
        right.pack(side="left", fill="x", expand=True, padx=(px(6), 0))
        pw = self._field(left, "Password (8+ characters)", show="•")
        pw2 = self._field(right, "Confirm password", show="•")
        btn = ttk.Button(t, text="Activate and sign in", style="Primary.TButton")
        btn.pack(fill="x", pady=(px(20), 0))
        code.focus_set()

        def submit():
            if not all(x.get().strip() for x in (code, act, email, pw)):
                self._message("warning", "Some details are missing", "Please fill in every field.")
                return
            if len(pw.get()) < 8:
                self._message("warning", "Password too short", "The password must be at least 8 characters.")
                return
            if pw.get() != pw2.get():
                self._message("warning", "Passwords don't match", "Type the same password in both boxes.")
                return
            btn.state(["disabled"])
            self.run_bg(lambda: self.agent.activate(code.get(), act.get(), email.get(), pw.get()),
                        lambda _: self._after_sign_in(),
                        lambda exc: (btn.state(["!disabled"]), self._show_error(exc)))

        btn.configure(command=submit)

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
        px = self.theme.px
        self.show_window()
        policy = self.agent.policy or {}
        f = self._swap()
        heading = {
            "initial": "Monitoring notice",
            "update": "The notice has changed",
            "view": "Monitoring notice",
        }[mode]
        if mode != "view":
            self._set_header_status("Waiting for you", P["faint"])
        ttk.Label(f, text=heading, style="PageH1.TLabel").pack(anchor="w")
        ttk.Label(f, text=f"{self.agent.profile.organization_name} · version {policy.get('version', '?')}",
                  style="PageMuted.TLabel").pack(anchor="w", pady=(0, px(12)))
        card = self._card(f, expand=True)

        buttons = ttk.Frame(card)
        buttons.pack(side="bottom", fill="x", pady=(px(14), 0))
        reading = ttk.Frame(card)
        reading.pack(side="top", fill="both", expand=True)
        box = tk.Text(reading, wrap="word", font=self.theme.font["reading"], relief="flat", bd=0,
                      bg=P["card"], fg=P["text_soft"], padx=px(2), pady=px(2), spacing1=px(1), spacing3=px(2),
                      highlightthickness=0, cursor="arrow", height=10)
        bar = ttk.Scrollbar(reading, orient="vertical", command=box.yview)
        box.configure(yscrollcommand=bar.set)
        bar.pack(side="right", fill="y")
        box.pack(side="left", fill="both", expand=True)
        box.tag_configure("title", font=self.theme.font["reading_title"], foreground=P["navy"], spacing3=px(8))
        box.tag_configure("heading", font=self.theme.font["reading_head"], foreground=P["text"],
                          spacing1=px(12), spacing3=px(3))
        for i, line in enumerate((policy.get("notice_text") or "").split("\n")):
            stripped = line.strip()
            tag = "title" if i == 0 else ("heading" if stripped and stripped.isupper() and len(stripped) < 40 else ())
            box.insert("end", line + "\n", tag)
        box.configure(state="disabled")

        if mode == "view" and not self.agent.needs_acknowledgement:
            ack_at = policy.get("acknowledged_at") or ""
            ttk.Label(buttons, text=f"Acknowledged {ack_at[:16].replace('T', ' ')} (UTC)",
                      style="Muted.TLabel").pack(side="left")
            ttk.Button(buttons, text="Back", command=self.show_status).pack(side="right")
            return

        agreed = tk.BooleanVar(value=False)
        ttk.Checkbutton(card, text="I have read and understood this notice.", variable=agreed,
                        command=lambda: ack.state(["!disabled"] if agreed.get() else ["disabled"])).pack(
            side="bottom", anchor="w", pady=(px(12), 0))
        ack = ttk.Button(buttons, text="Acknowledge" + (" and start" if mode == "initial" else ""),
                         style="Primary.TButton")
        ack.state(["disabled"])
        ack.pack(side="right")
        if mode == "initial":
            ttk.Button(buttons, text="Sign out", command=self._sign_out).pack(side="right", padx=(0, px(8)))
        else:
            ttk.Button(buttons, text="Later", command=self.show_status).pack(side="right", padx=(0, px(8)))

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
                self.root.iconify()
                self.start_hidden = False
        self.run_bg(self.agent.start_tracking, on_ok)

    def show_status(self) -> None:
        px = self.theme.px
        f = self._swap()
        p = self.agent.profile
        w = self.status_widgets

        bottom = ttk.Frame(f, style="Page.TFrame")
        bottom.pack(side="bottom", fill="x")
        ttk.Button(bottom, text="Monitoring notice", style="PageLink.TButton",
                   command=lambda: self.show_notice("view")).pack(side="left")
        ttk.Button(bottom, text="Sign out", style="PageLink.TButton", command=self._sign_out).pack(side="right")
        ttk.Label(bottom, text=f"v{VERSION}", style="PageMuted.TLabel").pack(side="left", expand=True)

        card = self._card(f)
        ttk.Label(card, text=p.name, style="H2.TLabel").pack(anchor="w")
        ttk.Label(card, text=f"{p.organization_name} · {p.employee_code}", style="Muted.TLabel").pack(anchor="w")
        w["state"] = ttk.Label(card, text="", style="State.TLabel", compound="left")
        w["state"].pack(anchor="w", pady=(px(12), 0))
        w["current"] = ttk.Label(card, text="", style="Muted.TLabel", wraplength=px(380))
        w["current"].pack(anchor="w", pady=(px(2), 0))

        ttk.Label(card, text="TODAY", style="Field.TLabel").pack(anchor="w", pady=(px(12), px(6)))
        tiles = ttk.Frame(card)
        tiles.pack(fill="x")
        for i, key in enumerate(("active", "idle", "away", "paused")):
            tiles.columnconfigure(i, weight=1, uniform="tile")
            tile = self.theme.frame(tiles, "Tile.TFrame")
            tile.grid(row=0, column=i, sticky="nsew", padx=(0 if i == 0 else px(4), 0 if i == 3 else px(4)))
            w[f"t_{key}"] = ttk.Label(tile, text="0h 00m", style="TileValue.TLabel")
            w[f"t_{key}"].pack(anchor="w")
            ttk.Label(tile, text=key.capitalize(), style="Tile.TLabel").pack(anchor="w")

        work = self._card(f, pady=(px(12), 0))
        ttk.Label(work, text="PROJECT", style="Field.TLabel").pack(anchor="w", pady=(0, px(6)))
        row = ttk.Frame(work)
        row.pack(fill="x")
        w["project"] = ttk.Combobox(row, state="readonly", font=self.theme.font["body"])
        w["project"].pack(side="left", fill="x", expand=True)
        w["project"].bind("<<ComboboxSelected>>", self._on_project_selected)
        ttk.Button(row, text="New", command=self._new_project).pack(side="left", padx=(px(8), 0))
        self._fill_projects()
        w["pause"] = ttk.Button(work, command=self._toggle_pause)
        w["pause"].pack(fill="x", pady=(px(10), 0))

        w["sync"] = ttk.Label(f, text="", style="PageMuted.TLabel", compound="left")
        w["sync"].pack(anchor="w", pady=(px(10), 0))
        w["tracked"] = ttk.Label(f, text="", style="PageMuted.TLabel", wraplength=px(420), justify="left")
        w["tracked"].pack(anchor="w", pady=(px(6), 0))
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
        sched = s.schedule
        if sched.mode == "work_hours":
            days = ", ".join(("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")[d - 1] for d in sorted(sched.work_days))
            when = (f"During working hours ({days}, {sched.work_start:%H:%M}–{sched.work_end:%H:%M}) "
                    "Mycroscope records ")
            outside = (" Outside working hours it only notes that the PC was in use, never what for."
                       if s.flag_after_hours_use else " Outside working hours it records nothing.")
        else:
            when = "While you are signed in, Mycroscope records "
            outside = ""
        extra = " Integrity checks are on." if s.detect_tampering else ""
        return (when + ", ".join(items) + "." + outside +
                " Never keystrokes, screenshots or file contents." + extra)

    def _refresh_status(self) -> None:
        w = self.status_widgets
        if not w or not self.agent.profile:
            return
        live = self.agent.live_status()
        state = live.get("state", "logged_out")
        label, color = STATE_LABELS.get(state, (state, C["text"]))
        w["state"].configure(text="  " + label, image=self.theme.dot(color, 12))
        self._set_header_status(label.split(" (")[0].split(" —")[0], color)
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
            sync, dot = f"Offline: {pending} item(s) saved on this PC, will upload automatically", C["warning"]
        elif pending > 2:
            sync, dot = f"Uploading… {pending} item(s) waiting", P["cyan"]
        else:
            sync, dot = "Connected · data up to date", C["success"]
        w["sync"].configure(text="  " + sync, image=self.theme.dot(dot, 8, P["page"]))
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
        name = self._ask_text("New project", "Project name")
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
        if not self._confirm("Sign out?", "Tracking stops on this PC until someone signs in again.",
                             "Sign out", danger=True):
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
        self.root.iconify()
        if self.agent.tracking:
            self._notify("Mycroscope is still tracking. It stays on the taskbar; sign out to stop.")
        else:
            self._notify("Mycroscope will remind you to sign in every few minutes while you use this PC.")

    def _on_session_end(self) -> None:
        log.info("Windows session ending")
        self.agent.windows_session_ending = True
        self._quit()

    def _quit(self) -> None:
        self._shutdown(user_requested=True)
        self.root.destroy()
