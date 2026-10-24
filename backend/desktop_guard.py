"""Windows posture companion with a reversible, bounded work-pause overlay.

This helper reads only short-lived numeric values and flags from localhost. It does not
access camera frames, lock Windows, or intercept system-wide keyboard events.
"""
import json
import math
import sys
import time
from urllib.request import Request, urlopen

try:
    import tkinter as tk
except ModuleNotFoundError:  # Allow headless unit tests on environments without python3-tk.
    class _TkFallback:
        ROUND = "round"
        TclError = Exception

        class Tk:
            pass

        class Toplevel:
            pass

        class Canvas:
            pass

        class Frame:
            pass

        class Label:
            pass

        class Button:
            pass

        class StringVar:
            def __init__(self, value=""):
                self.value = value

            def set(self, value):
                self.value = value

    tk = _TkFallback()


STATE_URL = "http://127.0.0.1:8000/api/posture-guard/state"
DISMISS_URL = "http://127.0.0.1:8000/api/posture-guard/dismiss"
POLL_MS = 500
SKIP_SECONDS = 120
BACKGROUND = "#010203"  # Windows transparent-color key.
WINDOW_WIDTH, WINDOW_HEIGHT = 328, 232
FRAME_MS = 90
FIRST_KITTEN_SECONDS = 5
SECOND_KITTEN_SECONDS = 13
MAX_PAUSE_SECONDS = 30
PAUSE_COOLDOWN_SECONDS = 120
GROW_START_SECONDS = 5
GROW_FULL_SECONDS = 30
MAX_SCREEN_FRACTION = 0.5


def growth_progress(bad_seconds):
    """Smoothly grow after 5 seconds, reaching the size cap after 30 seconds."""
    t = max(0.0, min(1.0, (bad_seconds - GROW_START_SECONDS) /
                     (GROW_FULL_SECONDS - GROW_START_SECONDS)))
    return t * t * (3 - 2 * t)


def cat_window_size(screen_width, screen_height, growth):
    """The largest cat window occupies about half ONE screen, not half each axis."""
    area = screen_width * screen_height * MAX_SCREEN_FRACTION
    max_height = min(screen_height * .92, math.sqrt(area / 1.12))
    max_width = area / max_height
    if max_width > screen_width * .94:
        max_width = screen_width * .94
        max_height = area / max_width
    base_width, base_height = min(WINDOW_WIDTH, screen_width), min(WINDOW_HEIGHT, screen_height)
    p = max(0.0, min(1.0, growth))
    return (round(base_width + (max(base_width, max_width) - base_width) * p),
            round(base_height + (max(base_height, max_height) - base_height) * p))


class PostureDuration:
    """Count measured bad posture; pause at 60–69 and reset on recovery/loss."""
    def __init__(self):
        self.seconds = 0.0
        self.last_at = None
        self.was_bad = False

    def update(self, score, now):
        gap = 0 if self.last_at is None else now - self.last_at
        if score is None or score >= 70 or gap < 0 or gap > 3:
            self.seconds = 0.0
            self.was_bad = False
        if score is not None and score < 60 and self.was_bad:
            self.seconds = min(GROW_FULL_SECONDS, self.seconds + gap)
        self.was_bad = score is not None and score < 60
        self.last_at = now
        return self.seconds


def cat_scale(score):
    """Keep the floating cat the same relative size as the browser SVG cat."""
    severity = max(0.0, min(1.0, (100.0 - score) / 65.0))
    return 0.90 + 0.68 * severity


def kitten_count(score, bad_seconds, playful=True):
    """At most two small companions; never multiply for good posture."""
    if not playful or score is None or score >= 70:
        return 0
    return int(bad_seconds >= FIRST_KITTEN_SECONDS) + int(
        bad_seconds >= SECOND_KITTEN_SECONDS)


def should_pause_for_kittens(score, bad_seconds, playful, pause_on_kittens):
    """Two total cats (one parent and one kitten) are enough to pause work."""
    return bool(pause_on_kittens and kitten_count(score, bad_seconds, playful) >= 1)


def fetch_state():
    """A missing server or stale browser measurement means no cat on screen."""
    try:
        with urlopen(STATE_URL, timeout=0.35) as response:
            state = json.load(response)
        score = state.get("score")
        if type(score) not in (int, float) or not 0 <= score <= 100:
            score = None
        result = {"score": score, "active": state.get("active") is True,
                  "playful": state.get("playful") is not False,
                  "pause_on_kittens": state.get("pause_on_kittens") is True,
                  "face_close": state.get("face_close") is True,
                  "grow": state.get("grow") is not False}
        if state.get("zoom_hint") is True:
            result["zoom_hint"] = True
        return result
    except (OSError, ValueError, TypeError, AttributeError):
        return {"score": None, "active": False, "playful": False,
                "pause_on_kittens": False, "face_close": False, "grow": False}


def report_dismiss():
    """Notify localhost that the user dismissed the desktop cat or pause overlay."""
    try:
        req = Request(DISMISS_URL, data=b"{}", headers={"Content-Type": "application/json"}, method="POST")
        with urlopen(req, timeout=0.25):
            pass
    except OSError:
        pass


def acquire_single_instance():
    """Prevent duplicate cats when a user also starts the older helper BAT."""
    import ctypes
    kernel32 = ctypes.windll.kernel32
    kernel32.CreateMutexW.restype = ctypes.c_void_p
    handle = kernel32.CreateMutexW(None, False, "Local\\ErgoPulseDesktopCat")
    if not handle:
        return False
    if kernel32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
        kernel32.CloseHandle(ctypes.c_void_p(handle))
        return False
    return True


class DesktopCat:
    def __init__(self, root):
        self.root = root
        self.visible = False
        self.suppressed_until = 0.0
        self.drag_offset = (0, 0)
        self.score = None
        self.active = False
        self.playful = True
        self.pause_on_kittens = False
        self.face_close = False
        self.grow = True
        self.zoom_hint = False
        self.duration = PostureDuration()
        self.bad_seconds = 0.0
        self.current_growth = 0.0
        self.window_width, self.window_height = WINDOW_WIDTH, WINDOW_HEIGHT
        self.pause_suppressed_until = 0.0
        self.blocked_since = None
        self.block_generation = 0
        self.started_at = time.monotonic()
        self.current_scale = cat_scale(100)
        root.title("ErgoPulse — 姿勢ねこ")
        root.overrideredirect(True)
        root.configure(bg=BACKGROUND)
        root.attributes("-topmost", True)
        self.canvas = tk.Canvas(root, width=WINDOW_WIDTH, height=WINDOW_HEIGHT,
                                bg=BACKGROUND, borderwidth=0, highlightthickness=0)
        self.canvas.pack(fill="both", expand=True)
        # Color-key transparency is supported by Tk on Windows. If disabled by
        # the display system, use a legible small card rather than a black box.
        try:
            root.attributes("-transparentcolor", BACKGROUND)
        except tk.TclError:
            root.configure(bg="#fff7e8")
            self.canvas.configure(bg="#fff7e8")
        left = max(0, root.winfo_screenwidth() - WINDOW_WIDTH - 24)
        top = max(0, root.winfo_screenheight() - WINDOW_HEIGHT - 70)
        root.geometry(f"{WINDOW_WIDTH}x{WINDOW_HEIGHT}+{left}+{top}")
        self.anchor_right, self.anchor_bottom = left + WINDOW_WIDTH, top + WINDOW_HEIGHT
        root.bind("<Escape>", self.skip)
        self.canvas.bind("<ButtonPress-1>", self.start_drag)
        self.canvas.bind("<B1-Motion>", self.drag)
        self.canvas.bind("<Button-3>", lambda _event: self.quit())
        root.protocol("WM_DELETE_WINDOW", self.quit)
        self.create_pause_overlay()
        root.withdraw()
        root.after(POLL_MS, self.poll)
        root.after(FRAME_MS, self.animate)

    def create_pause_overlay(self):
        """Full-screen topmost work break; deliberately NOT an OS input hook."""
        blocker = tk.Toplevel(self.root)
        blocker.title("ErgoPulse — 姿勢を整える時間")
        blocker.overrideredirect(True)
        blocker.configure(bg="#18231f")
        blocker.attributes("-topmost", True)
        try:
            blocker.attributes("-alpha", 0.97)
        except tk.TclError:
            pass
        width, height = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        left = top = 0
        if sys.platform == "win32":
            try:
                import ctypes
                metrics = ctypes.windll.user32.GetSystemMetrics
                # Include all monitors, including ones with negative origins.
                left, top = metrics(76), metrics(77)
                width, height = metrics(78), metrics(79)
                if width <= 0 or height <= 0:
                    raise ValueError("invalid virtual desktop")
            except (OSError, ValueError, AttributeError):
                width, height, left, top = (
                    self.root.winfo_screenwidth(), self.root.winfo_screenheight(), 0, 0)
        blocker.geometry(f"{width}x{height}{left:+d}{top:+d}")
        card = tk.Frame(blocker, bg="#f9f5ec", padx=44, pady=37,
                        highlightbackground="#ddc9a4", highlightthickness=2)
        card.place(relx=.5, rely=.5, anchor="center")
        tk.Label(card, text="🐈  🐈", bg="#f9f5ec", fg="#886e55",
                 font=("Segoe UI Emoji", 38)).pack(pady=(0, 6))
        tk.Label(card, text="ねこが2匹に！ ちょっと姿勢を整えよう",
                 bg="#f9f5ec", fg="#304d3a",
                 font=("Yu Gothic UI", 19, "bold")).pack(pady=(0, 12))
        self.pause_message = tk.StringVar(value="姿勢スコア70点以上で再開します。")
        tk.Label(card, textvariable=self.pause_message,
                 bg="#f9f5ec", fg="#677064",
                 font=("Yu Gothic UI", 12)).pack(pady=(0, 17))
        tk.Button(card, text="作業を再開する（2分間休止） / Esc",
                  command=self.bypass_block, cursor="hand2",
                  font=("Yu Gothic UI", 11, "bold"), bg="#3a6750",
                  fg="white", relief="flat", padx=20, pady=10).pack()
        tk.Label(card, text="カメラが止まった場合も自動解除。Windowsはロックしません。",
                 bg="#f9f5ec", fg="#8a9185",
                 font=("Yu Gothic UI", 9)).pack(pady=(14, 0))
        blocker.bind("<Escape>", self.bypass_block)
        blocker.protocol("WM_DELETE_WINDOW", self.bypass_block)
        blocker.withdraw()
        self.blocker = blocker

    def start_block(self, now):
        self.blocked_since = now
        self.block_generation += 1
        generation = self.block_generation
        self.blocker.deiconify()
        self.blocker.lift()
        # This takes focus while the reminder is visible; Alt+Tab and Windows
        # security shortcuts remain available as emergency escape routes.
        self.blocker.focus_force()
        self.root.after(MAX_PAUSE_SECONDS * 1000,
                        lambda: self.timeout_block(generation))

    def end_block(self, cooldown=False):
        if self.blocked_since is None:
            return
        self.blocked_since = None
        self.block_generation += 1
        self.blocker.withdraw()
        if cooldown:
            self.pause_suppressed_until = time.monotonic() + PAUSE_COOLDOWN_SECONDS

    def timeout_block(self, generation):
        if self.blocked_since is not None and self.block_generation == generation:
            self.end_block(cooldown=True)

    def bypass_block(self, _event=None):
        was_blocked = self.blocked_since is not None
        self.end_block(cooldown=True)
        if was_blocked:
            report_dismiss()

    def update_block(self, now, bad_seconds):
        requested = should_pause_for_kittens(self.score, bad_seconds, self.playful,
                                             self.pause_on_kittens) and not getattr(self, "grow", False)
        if self.blocked_since is not None:
            if not requested or now - self.blocked_since >= MAX_PAUSE_SECONDS:
                self.end_block(cooldown=requested)
            else:
                remaining = max(1, math.ceil(MAX_PAUSE_SECONDS - (now - self.blocked_since)))
                self.pause_message.set(
                    ("顔が近い。 " if getattr(self, "face_close", False) else "") +
                    f"姿勢スコア70点以上で解除 · 安全のため最長あと{remaining}秒 · Escで即解除")
        elif (requested and now >= self.pause_suppressed_until
              and now >= self.suppressed_until):
            self.start_block(now)

    def start_drag(self, event):
        self.drag_offset = (event.x_root - self.root.winfo_rootx(),
                            event.y_root - self.root.winfo_rooty())

    def drag(self, event):
        left = max(0, min(self.root.winfo_screenwidth() - self.window_width,
                          event.x_root - self.drag_offset[0]))
        top = max(0, min(self.root.winfo_screenheight() - self.window_height,
                         event.y_root - self.drag_offset[1]))
        self.anchor_right, self.anchor_bottom = left + self.window_width, top + self.window_height
        self.root.geometry(f"+{left}+{top}")

    def resize_for_growth(self, growth):
        screen_width, screen_height = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        width, height = cat_window_size(screen_width, screen_height, growth)
        if (width, height) == (self.window_width, self.window_height):
            return
        left = max(0, min(screen_width - width, self.anchor_right - width))
        top = max(0, min(screen_height - height, self.anchor_bottom - height))
        self.window_width, self.window_height = width, height
        self.root.geometry(f"{width}x{height}+{left}+{top}")

    def draw_kitty(self, cx, cy, scale, blink=False, tail_wag=0,
                   paw_wave=0, color="#cdb89a"):
        """Draw one vector cat. Moving the eyes, tail and center animates it."""
        c = self.canvas
        s = scale
        x = lambda value: cx + (value - 80) * s
        y = lambda value: cy + (value - 80) * s

        def oval(x1, y1, x2, y2, **kwargs):
            c.create_oval(x(x1), y(y1), x(x2), y(y2), **kwargs)

        def line(coords, **kwargs):
            points = []
            for i in range(0, len(coords), 2):
                points.extend((x(coords[i]), y(coords[i + 1])))
            c.create_line(*points, **kwargs)

        def polygon(coords, **kwargs):
            points = []
            for i in range(0, len(coords), 2):
                points.extend((x(coords[i]), y(coords[i + 1])))
            c.create_polygon(*points, **kwargs)

        # Tail and body sit behind the head; all drawing is vector-based.
        line((118, 108, 145 + tail_wag * 8, 96, 143 + tail_wag * 17, 77),
             fill="#9c8368",
             width=max(4, 11 * s), smooth=True, capstyle=tk.ROUND)
        oval(29, 87, 131, 149, fill="#b8a58a", outline="")
        polygon((34, 69, 37, 26, 62, 45, 80, 40, 98, 45,
                 123, 26, 126, 69, 126, 85, 115, 102, 96, 113,
                 65, 113, 45, 103, 34, 88), fill=color,
                outline="#957e64", width=max(1, 2 * s))
        polygon((41, 35, 45, 54, 59, 46), fill="#df9fa0", outline="")
        polygon((119, 35, 115, 54, 101, 46), fill="#df9fa0", outline="")
        if blink:
            line((57, 77, 66, 77), fill="#35483c", width=max(1.5, 2.5 * s))
            line((94, 77, 103, 77), fill="#35483c", width=max(1.5, 2.5 * s))
        else:
            oval(56.5, 69, 67.5, 83, fill="#35483c", outline="")
            oval(93.5, 69, 104.5, 83, fill="#35483c", outline="")
        oval(41, 86, 55, 94, fill="#dfa5a0", outline="")
        oval(105, 86, 119, 94, fill="#dfa5a0", outline="")
        polygon((74, 90, 80, 85, 86, 90, 80, 95), fill="#b97678", outline="")
        line((80, 94, 74, 100, 69, 96), fill="#735e52", width=max(1, 2 * s), smooth=True)
        line((80, 94, 86, 100, 91, 96), fill="#735e52", width=max(1, 2 * s), smooth=True)
        for coords in ((45, 92, 20, 85), (46, 99, 22, 103),
                       (115, 92, 140, 85), (114, 99, 138, 103)):
            line(coords, fill="#9d8975", width=max(1, 1.7 * s))
        oval(37, 131 - 32 * paw_wave, 71, 149 - 32 * paw_wave,
             fill=color, outline="")
        oval(89, 131, 123, 149, fill=color, outline="")

    def draw_cat(self, score, active, playful=False, bad_seconds=0,
                 elapsed=0.0, display_scale=None, growth=0.0,
                 width=WINDOW_WIDTH, height=WINDOW_HEIGHT, face_close=False,
                 zoom_hint=False):
        c = self.canvas
        c.delete("all")
        c.create_text(16, 17, text="ErgoPulse", anchor="w",
                      font=("Segoe UI", 9, "bold"), fill="#537264")
        # A fixed-size, opaque close control remains legible even over another app.
        c.create_rectangle(width - 44, 2, width - 3, 34, fill="#fff7e8",
                           outline="#ddc9a4", tags=("skip",))
        c.create_text(width - 23, 17, text="×", font=("Segoe UI", 19),
                      fill="#735e52", tags=("skip",))
        c.tag_bind("skip", "<Button-1>", self.skip)

        shown_score = score if score is not None else 100
        swaying = playful and shown_score >= 70 and not face_close
        restless = playful and shown_score < 60
        move_x = (13 * math.sin(elapsed * 1.0) if swaying else
                  3.5 * math.sin(elapsed * 7) if restless else 0)
        bounce = 4 * math.sin(elapsed * 2.6) if swaying else 0
        main_scale = (cat_scale(shown_score) if display_scale is None else display_scale) * .72
        top = 98 if (face_close and zoom_hint) else 88 if face_close else 36
        fitted_scale = min((width - 34) / 150, (height - top - 36) / 123)
        main_scale = min(main_scale, max(.2, fitted_scale))
        main_scale += (max(main_scale, fitted_scale) - main_scale) * growth
        main_x = width / 2 - 12 * main_scale
        main_y = (top + height - 36) / 2 - 7.5 * main_scale
        affectionate = swaying and 1.8 < elapsed % 5.6 < 3.9
        self.draw_kitty(main_x + move_x, main_y + bounce, main_scale,
                        blink=playful and elapsed % 4.3 < 0.17,
                        tail_wag=math.sin(elapsed * 3) if playful else 0,
                        paw_wave=max(0, math.sin(elapsed * 7)) * .85 if affectionate else 0)

        # Kittens remain small while the parent fills the expanding window.
        for i in range(kitten_count(score, bad_seconds, playful)):
            threshold = (FIRST_KITTEN_SECONDS, SECOND_KITTEN_SECONDS)[i]
            emergence = min(1, max(0.05, (bad_seconds - threshold) / 1.3))
            cx = (54, width - 51)[i]
            cy = height - 62 + 3 * math.sin(elapsed * 3.4 + i * 2)
            self.draw_kitty(cx, cy, (.34 + .08 * i) * emergence,
                            blink=(elapsed + i * 1.8) % 4.3 < 0.19,
                            tail_wag=math.sin(elapsed * 3.9 + i),
                            color=("#e1cdb6", "#b7a9a0")[i])

        if swaying:
            # Brief affection instead of a permanent attention-grabbing overlay.
            phase = elapsed % 5.6
            if 1.8 < phase < 3.9:
                c.create_text(width * .72, 50 - (phase - 1.8) * 9,
                              text="♥" if phase < 3.1 else "♥ ♥",
                              font=("Segoe UI Symbol", 18, "bold"),
                              fill="#e68da4")
            if elapsed % 12 < 2:
                c.create_text(width * .79, 100, text="ごろごろ…",
                              fill="#8b726d", font=("Yu Gothic UI", 8))

        message = "背すじを少し楽に伸ばそう" if active else "姿勢の目安"
        color = "#ac5e47" if shown_score < 60 else "#537264"
        c.create_rectangle(10, height - 34, width - 10, height - 4,
                           fill="#fff7e8", outline="")
        c.create_text(width / 2, height - 20,
                      text=f"{message} · {round(score)}点" if score is not None else "顔と両肩が映る位置で姿勢を確認",
                      font=("Yu Gothic UI", 11 if growth > .3 else 9, "bold"), fill=color)
        if face_close:
            box_bottom = 92 if zoom_hint else 80
            c.create_rectangle(16, 38, width - 16, box_bottom, fill="#fff0df", outline="#cd8058")
            c.create_text(width / 2, 54 if zoom_hint else 59, text="顔が近い",
                          font=("Yu Gothic UI", 18 if zoom_hint else 20, "bold"), fill="#9a462c")
            if zoom_hint:
                c.create_text(width / 2, 77, text="文字、小さくない？",
                              font=("Yu Gothic UI", 10, "bold"), fill="#7d4e2d")

    def set_visible(self, desired):
        if desired == self.visible:
            return
        self.visible = desired
        if desired:
            self.root.deiconify()
            # No focus_force: Word/VS Code keep receiving keyboard input.
        else:
            self.root.withdraw()

    def poll(self):
        state = fetch_state()
        score = state["score"]
        self.score = score
        self.active = state["active"]
        self.playful = state["playful"]
        self.pause_on_kittens = state["pause_on_kittens"]
        self.face_close = state["face_close"]
        self.grow = state["grow"]
        self.zoom_hint = state.get("zoom_hint") is True
        now = time.monotonic()
        suppressed = now < self.suppressed_until
        self.bad_seconds = self.duration.update(None if suppressed else score, now)
        show = (score is not None or self.face_close) and not suppressed
        if not show:
            self.current_growth = 0.0
            self.current_scale = cat_scale(100)
            self.resize_for_growth(0)
        self.set_visible(show)
        self.update_block(now, self.bad_seconds)
        self.root.after(POLL_MS, self.poll)

    def animate(self):
        if self.visible:
            now = time.monotonic()
            score = self.score if self.score is not None else 100
            self.current_scale += (cat_scale(score) - self.current_scale) * 0.23
            target = growth_progress(self.bad_seconds) if self.grow else 0.0
            self.current_growth += (target - self.current_growth) * .23
            if abs(target - self.current_growth) < .001:
                self.current_growth = target
            self.resize_for_growth(self.current_growth)
            self.draw_cat(self.score, self.active, playful=self.playful,
                          bad_seconds=self.bad_seconds, elapsed=now - self.started_at,
                          display_scale=self.current_scale, growth=self.current_growth,
                          width=self.window_width, height=self.window_height,
                          face_close=self.face_close, zoom_hint=getattr(self, "zoom_hint", False))
        self.root.after(FRAME_MS, self.animate)

    def skip(self, _event=None):
        self.suppressed_until = time.monotonic() + SKIP_SECONDS
        self.bad_seconds = self.duration.update(None, time.monotonic())
        self.current_growth = 0.0
        self.resize_for_growth(0)
        self.end_block(cooldown=True)
        self.set_visible(False)
        report_dismiss()
        return "break"

    def quit(self):
        self.end_block()
        self.set_visible(False)
        self.root.destroy()


if __name__ == "__main__":
    if sys.platform != "win32":
        print("この姿勢ねこはWindows用です。")
        sys.exit(1)
    if not acquire_single_instance():
        print("姿勢ねこはすでに起動しています。")
        sys.exit(0)
    print("姿勢ねこを待機中。猫をドラッグして移動できます。×で2分非表示。")
    print("終了するにはこの黒いウィンドウを閉じてください。")
    DesktopCat(tk.Tk()).root.mainloop()
