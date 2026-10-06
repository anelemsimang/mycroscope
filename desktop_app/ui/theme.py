"""Look of the agent window: brand colours, Poppins, and rounded widgets drawn with Pillow.

ttk cannot draw rounded corners itself, so every rounded surface is a small anti-aliased image
that ttk stretches as a 9-slice ("image" elements). Corners are baked onto the colour of the
surface the widget sits on, so each style names its surface.
"""

import ctypes
import sys
import tkinter as tk
from pathlib import Path
from tkinter import font as tkfont, ttk
from typing import Optional

from PIL import Image, ImageDraw, ImageFont, ImageTk

P = {
    "navy": "#1E3A8A", "navy_hover": "#1E40AF", "navy_deep": "#172554",
    "cyan": "#06B6D4", "cyan_dark": "#0891B2",
    "page": "#F1F5F9", "card": "#FFFFFF", "tile": "#F8FAFC", "track": "#EEF2F7",
    "border": "#E2E8F0", "border_strong": "#CBD5E1",
    "text": "#0F172A", "text_soft": "#334155", "muted": "#64748B", "faint": "#94A3B8",
    "danger": "#B91C1C", "danger_bg": "#FEF2F2", "danger_border": "#FECACA",
    "danger_solid": "#DC2626", "warning": "#D97706", "warning_bg": "#FFFBEB", "info_bg": "#ECFEFF",
    "navy_bg": "#EFF6FF",
    "disabled": "#CBD5E1",
}


def prepare_process(font_dir: Path) -> None:
    """Before the first Tk window: crisp text on scaled displays, and the bundled Poppins fonts."""
    if sys.platform != "win32":
        return
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except (AttributeError, OSError):
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except (AttributeError, OSError):
            pass
    FR_PRIVATE = 0x10
    for ttf in font_dir.glob("*.ttf"):
        try:
            ctypes.windll.gdi32.AddFontResourceExW(str(ttf), FR_PRIVATE, 0)
        except (AttributeError, OSError):
            pass


def _rounded(w: int, h: int, r: int, fill: str, bg: str, outline: Optional[str] = None, width: int = 1) -> Image.Image:
    ss = 4
    img = Image.new("RGBA", (w * ss, h * ss), bg)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, w * ss - 1, h * ss - 1), radius=r * ss, fill=outline or fill)
    if outline:
        b = width * ss
        d.rounded_rectangle((b, b, w * ss - 1 - b, h * ss - 1 - b), radius=max(r * ss - b, 0), fill=fill)
    return img.resize((w, h), Image.LANCZOS)


class Theme:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.scale = max(1.0, root.winfo_fpixels("1i") / 96.0)
        self._images: list = []
        self._dots: dict = {}
        self._frame_padding: dict[str, int] = {}
        families = set(tkfont.families(root))
        poppins = "Poppins" in families
        head = "Poppins SemiBold" if poppins else "Segoe UI Semibold"
        medium = "Poppins Medium" if poppins else "Segoe UI Semibold"
        body = "Poppins" if poppins else "Segoe UI"
        self.font = {
            "h1": (head, 17), "h2": (head, 13), "stat": (head, 14),
            "body": (body, 10), "small": (body, 9), "label": (medium, 9), "button": (medium, 10),
            "reading": ("Segoe UI", 10), "reading_head": (head, 10), "reading_title": (head, 12),
        }

    def px(self, v: float) -> int:
        return max(1, round(v * self.scale))

    def _photo(self, img: Image.Image) -> ImageTk.PhotoImage:
        photo = ImageTk.PhotoImage(img, master=self.root)
        self._images.append(photo)
        return photo

    def _slice(self, r: int, fill: str, bg: str, outline: Optional[str] = None, width: int = 1):
        r = self.px(r)
        size = 2 * r + self.px(8)
        return self._photo(_rounded(size, size, r, fill, bg, outline, self.px(width))), r + 1

    def dot(self, color: str, size: int = 10, bg: str = "#FFFFFF") -> ImageTk.PhotoImage:
        key = (color, size, bg)
        if key not in self._dots:
            s = self.px(size)
            self._dots[key] = self._photo(_rounded(s, s, s // 2, color, bg))
        return self._dots[key]

    def badge(self, kind: str, font_file: Path) -> ImageTk.PhotoImage:
        """Round icon for dialogs: error, warning, info or question."""
        key = ("badge", kind)
        if key in self._dots:
            return self._dots[key]
        glyph, fg, bg = {
            "error": ("!", P["danger_solid"], P["danger_bg"]),
            "warning": ("!", P["warning"], P["warning_bg"]),
            "info": ("i", P["cyan_dark"], P["info_bg"]),
            "question": ("?", P["navy"], P["navy_bg"]),
        }[kind]
        size, ss = self.px(44), 4
        img = Image.new("RGBA", (size * ss, size * ss), P["card"])
        d = ImageDraw.Draw(img)
        d.ellipse((0, 0, size * ss - 1, size * ss - 1), fill=bg)
        inner = size * ss * 0.22
        d.ellipse((inner, inner, size * ss - 1 - inner, size * ss - 1 - inner), fill=fg)
        try:
            font = ImageFont.truetype(str(font_file), int(size * ss * 0.36))
        except OSError:
            font = ImageFont.load_default()
        d.text((size * ss / 2, size * ss / 2), glyph, fill="white", font=font, anchor="mm")
        self._dots[key] = self._photo(img.resize((size, size), Image.LANCZOS))
        return self._dots[key]

    def image(self, path: Path, height: int) -> Optional[ImageTk.PhotoImage]:
        try:
            img = Image.open(path).convert("RGBA")
        except OSError:
            return None
        h = self.px(height)
        return self._photo(img.resize((max(1, round(img.width * h / img.height)), h), Image.LANCZOS))

    # ---- styles ----------------------------------------------------------
    def apply(self) -> None:
        s = ttk.Style(self.root)
        s.theme_use("clam")
        f, px = self.font, self.px
        s.configure(".", background=P["card"], foreground=P["text"], font=f["body"], borderwidth=0,
                    focuscolor=P["card"], selectbackground=P["cyan"], selectforeground="white")

        for name, bg in (("TFrame", P["card"]), ("Page.TFrame", P["page"]), ("Tile.TFrame", P["tile"])):
            s.configure(name, background=bg)
        self._frame(s, "Card.TFrame", 14, P["card"], P["page"], P["border"], px(18))
        self._frame(s, "Tile.TFrame", 10, P["tile"], P["card"], P["border"], px(8))
        self._frame(s, "Track.TFrame", 10, P["track"], P["card"], None, px(4))
        self._frame(s, "Danger.TFrame", 10, P["danger_bg"], P["card"], P["danger_border"], px(12))

        labels = {
            "TLabel": (P["card"], P["text"], f["body"]),
            "H1.TLabel": (P["card"], P["text"], f["h1"]),
            "H2.TLabel": (P["card"], P["text"], f["h2"]),
            "Muted.TLabel": (P["card"], P["muted"], f["small"]),
            "Field.TLabel": (P["card"], P["text_soft"], f["label"]),
            "State.TLabel": (P["card"], P["text"], f["h2"]),
            "Page.TLabel": (P["page"], P["text"], f["body"]),
            "PageH1.TLabel": (P["page"], P["text"], f["h1"]),
            "PageMuted.TLabel": (P["page"], P["muted"], f["small"]),
            "Tile.TLabel": (P["tile"], P["muted"], f["small"]),
            "TileValue.TLabel": (P["tile"], P["text"], f["stat"]),
            "Danger.TLabel": (P["danger_bg"], P["danger"], f["small"]),
        }
        for name, (bg, fg, font) in labels.items():
            s.configure(name, background=bg, foreground=fg, font=font)

        self._button(s, "Primary.TButton", P["card"], fill=(P["navy"], P["navy_hover"], P["navy_deep"], P["disabled"]),
                     fg=("white", "white"))
        self._button(s, "Danger.TButton", P["card"], fill=(P["danger_solid"], P["danger"], "#991B1B", P["disabled"]),
                     fg=("white", "white"))
        self._button(s, "TButton", P["card"], fill=("#FFFFFF", P["tile"], P["track"], "#FFFFFF"),
                     fg=(P["text"], P["faint"]), outline=P["border_strong"])
        self._button(s, "SegOn.TButton", P["track"], fill=("#FFFFFF",) * 4, fg=(P["navy"], P["navy"]),
                     outline=P["border"], pad=(14, 7))
        self._button(s, "SegOff.TButton", P["track"], fill=(P["track"], P["border"], P["border"], P["track"]),
                     fg=(P["muted"], P["faint"]), pad=(14, 7))
        for name, bg in (("Link.TButton", P["card"]), ("PageLink.TButton", P["page"])):
            s.layout(name, [("Button.padding", {"sticky": "nsew", "children": [("Button.label", {"sticky": "nsew"})]})])
            s.configure(name, background=bg, foreground=P["cyan_dark"], font=f["label"], padding=(px(2), px(4)))
            s.map(name, foreground=[("disabled", P["faint"]), ("pressed", P["navy_deep"]), ("active", P["navy"])],
                  background=[("active", bg)])

        self._field(s)
        self._checkbox(s)

        s.layout("Vertical.TScrollbar", [("Vertical.Scrollbar.trough", {"sticky": "ns", "children": [
            ("Vertical.Scrollbar.thumb", {"expand": "1", "sticky": "nsew"})]})])
        s.configure("Vertical.TScrollbar", troughcolor=P["card"], background=P["border_strong"], bordercolor=P["card"],
                    lightcolor=P["border_strong"], darkcolor=P["border_strong"], arrowsize=px(8), gripcount=0)
        s.map("Vertical.TScrollbar", background=[("active", P["faint"])],
              lightcolor=[("active", P["faint"])], darkcolor=[("active", P["faint"])])
        s.configure("Horizontal.TProgressbar", troughcolor=P["track"], background=P["cyan"], bordercolor=P["track"],
                    lightcolor=P["cyan"], darkcolor=P["cyan"], thickness=px(4))

        self.root.option_add("*TCombobox*Listbox.font", f["body"])
        self.root.option_add("*TCombobox*Listbox.background", "#FFFFFF")
        self.root.option_add("*TCombobox*Listbox.foreground", P["text"])
        self.root.option_add("*TCombobox*Listbox.selectBackground", P["navy"])
        self.root.option_add("*TCombobox*Listbox.selectForeground", "white")
        self.root.option_add("*TCombobox*Listbox.borderWidth", 0)
        self.root.option_add("*TCombobox*Listbox.relief", "flat")

    def frame(self, parent, style: str, **kw) -> ttk.Frame:
        """ttk frames take padding only as a widget option, not from the style."""
        return ttk.Frame(parent, style=style, padding=self._frame_padding.get(style, 0), **kw)

    def _frame(self, s: ttk.Style, name: str, r: int, fill: str, bg: str, outline: Optional[str], padding: int) -> None:
        img, border = self._slice(r, fill, bg, outline)
        el = name.replace(".", "_") + ".bg"
        s.element_create(el, "image", img, border=border, padding=0, sticky="nsew")
        s.layout(name, [(el, {"sticky": "nsew"})])
        s.configure(name, background=fill)
        self._frame_padding[name] = padding

    def _button(self, s: ttk.Style, name: str, surface: str, fill: tuple, fg: tuple,
                outline: Optional[str] = None, pad: tuple = (18, 9)) -> None:
        normal, hover, pressed, disabled = (self._slice(10, c, surface, outline) for c in fill)
        el = name.replace(".", "_") + ".bg"
        s.element_create(el, "image", normal[0], ("disabled", disabled[0]), ("pressed", pressed[0]),
                         ("active", hover[0]), border=normal[1], padding=0, sticky="nsew")
        s.layout(name, [(el, {"sticky": "nsew", "children": [
            ("Button.padding", {"sticky": "nsew", "children": [("Button.label", {"sticky": "nsew"})]})]})])
        s.configure(name, background=surface, foreground=fg[0], font=self.font["button"], anchor="center",
                    padding=(self.px(pad[0]), self.px(pad[1])))
        s.map(name, foreground=[("disabled", fg[1])], background=[("active", surface)])

    def _field(self, s: ttk.Style) -> None:
        normal, border = self._slice(9, "#FFFFFF", P["card"], P["border_strong"])
        focus, _ = self._slice(9, "#FFFFFF", P["card"], P["cyan"], 2)
        disabled, _ = self._slice(9, P["tile"], P["card"], P["border"])
        inset = self.px(2)
        s.element_create("Rounded.field", "image", normal, ("disabled", disabled), ("focus", focus),
                         border=border, padding=(inset, inset, self.px(8), inset), sticky="nsew")
        pad = (self.px(12), self.px(9))
        s.layout("TEntry", [("Rounded.field", {"sticky": "nsew", "children": [
            ("Entry.padding", {"sticky": "nsew", "children": [("Entry.textarea", {"sticky": "nsew"})]})]})])
        s.configure("TEntry", padding=pad, foreground=P["text"], insertcolor=P["navy"], fieldbackground="#FFFFFF")
        s.layout("TCombobox", [("Rounded.field", {"sticky": "nsew", "children": [
            ("Combobox.downarrow", {"side": "right", "sticky": "ns"}),
            ("Combobox.padding", {"expand": "1", "sticky": "nsew", "children": [
                ("Combobox.textarea", {"sticky": "nsew"})]})]})])
        s.configure("TCombobox", padding=pad, foreground=P["text"], background="#FFFFFF", fieldbackground="#FFFFFF",
                    arrowcolor=P["muted"], bordercolor="#FFFFFF", lightcolor="#FFFFFF", darkcolor="#FFFFFF",
                    arrowsize=self.px(12), selectbackground="#FFFFFF", selectforeground=P["text"])
        s.map("TCombobox", fieldbackground=[("readonly", "#FFFFFF")], background=[("active", "#FFFFFF")],
              selectbackground=[("readonly", "#FFFFFF")], selectforeground=[("readonly", P["text"])],
              arrowcolor=[("active", P["navy"])])

    def _checkbox(self, s: ttk.Style) -> None:
        size, gap = self.px(20), self.px(10)

        def box(checked: bool, disabled: bool = False) -> ImageTk.PhotoImage:
            ss = 4
            img = Image.new("RGBA", ((size + gap) * ss, size * ss), P["card"])
            d = ImageDraw.Draw(img)
            r, w = self.px(5) * ss, self.px(1.5) * ss
            fill = P["disabled"] if disabled and checked else (P["navy"] if checked else "#FFFFFF")
            d.rounded_rectangle((0, 0, size * ss - 1, size * ss - 1), radius=r,
                                fill=fill if checked else P["border_strong"])
            if not checked:
                d.rounded_rectangle((w, w, size * ss - 1 - w, size * ss - 1 - w), radius=r - w, fill=fill)
            else:
                pts = [(0.27, 0.52), (0.44, 0.68), (0.74, 0.34)]
                d.line([(x * size * ss, y * size * ss) for x, y in pts], fill="white", width=int(self.px(2.2) * ss),
                       joint="curve")
            return self._photo(img.resize((size + gap, size), Image.LANCZOS))

        s.element_create("Box.indicator", "image", box(False), ("disabled selected", box(True, True)),
                         ("selected", box(True)), sticky="")
        s.layout("TCheckbutton", [("Checkbutton.padding", {"sticky": "nsew", "children": [
            ("Box.indicator", {"side": "left", "sticky": ""}),
            ("Checkbutton.label", {"side": "left", "sticky": "nsew"})]})])
        s.configure("TCheckbutton", background=P["card"], foreground=P["text"], font=self.font["body"],
                    padding=(0, self.px(4)))
        s.map("TCheckbutton", background=[("active", P["card"])], foreground=[("disabled", P["faint"])])
