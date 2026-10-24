"""Headless checks for the optional Windows floating cat."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from desktop_guard import (DesktopCat, cat_scale, fetch_state, kitten_count,
                           should_pause_for_kittens, MAX_PAUSE_SECONDS,
                           PostureDuration, growth_progress, cat_window_size)


class FakeCanvas:
    def __init__(self):
        self.ovals = []
        self.texts = []

    def delete(self, *args):
        self.ovals = []
        self.texts = []

    def create_oval(self, *coords, **kwargs):
        self.ovals.append(coords)

    def create_line(self, *args, **kwargs):
        pass

    def create_rectangle(self, *args, **kwargs):
        pass

    def create_polygon(self, *args, **kwargs):
        pass

    def create_text(self, *args, **kwargs):
        self.texts.append(kwargs.get("text"))

    def tag_bind(self, *args):
        pass


class FakeRoot:
    def __init__(self):
        self.callbacks = []
        self.last_geometry = None
        self.showing = False

    def after(self, delay, callback):
        self.callbacks.append((delay, callback))

    def winfo_screenwidth(self):
        return 1920

    def winfo_screenheight(self):
        return 1080

    def geometry(self, geometry):
        self.last_geometry = geometry

    def deiconify(self):
        self.showing = True

    def withdraw(self):
        self.showing = False


class FakeBlocker:
    def __init__(self):
        self.showing = False

    def deiconify(self):
        self.showing = True

    def lift(self):
        pass

    def focus_force(self):
        pass

    def withdraw(self):
        self.showing = False


class FakeText:
    def __init__(self):
        self.value = ""

    def set(self, value):
        self.value = value


class DesktopCatTests(unittest.TestCase):
    def test_cat_grows_as_posture_score_drops(self):
        self.assertAlmostEqual(cat_scale(100), 0.9)
        self.assertAlmostEqual(cat_scale(35), 1.58)
        self.assertAlmostEqual(cat_scale(0), 1.58)
        helper = object.__new__(DesktopCat)
        helper.canvas = FakeCanvas()
        helper.draw_cat(100, False)
        small_width = helper.canvas.ovals[0][2] - helper.canvas.ovals[0][0]
        self.assertIn("姿勢の目安 · 100点", helper.canvas.texts)
        helper.draw_cat(35, True)
        large_width = helper.canvas.ovals[0][2] - helper.canvas.ovals[0][0]
        self.assertGreater(large_width, small_width * 1.7)
        self.assertIn("背すじを少し楽に伸ばそう · 35点", helper.canvas.texts)

    def test_network_error_hides_cat(self):
        with patch("desktop_guard.urlopen", side_effect=OSError("server stopped")):
            self.assertEqual(fetch_state(), {"score": None, "active": False,
                                             "playful": False,
                                             "pause_on_kittens": False,
                                             "face_close": False, "grow": False})

    def test_prolonged_bad_posture_fills_half_a_screen_and_is_capped(self):
        self.assertEqual(growth_progress(4.9), 0)
        self.assertGreater(growth_progress(15), 0)
        self.assertEqual(growth_progress(30), 1)
        self.assertEqual(growth_progress(300), 1)
        for sw, sh in ((1366, 768), (1920, 1080), (3440, 1440), (1080, 1920)):
            w, h = cat_window_size(sw, sh, 1)
            self.assertAlmostEqual(w * h / (sw * sh), .5, delta=.002)
            self.assertLessEqual(w, sw)
            self.assertLessEqual(h, sh)
            middle = cat_window_size(sw, sh, growth_progress(15))
            self.assertLess(middle[0], w)
            self.assertLess(middle[1], h)
        helper = object.__new__(DesktopCat)
        helper.canvas = FakeCanvas()
        helper.draw_cat(40, True, playful=False)
        small = helper.canvas.ovals[0]
        width, height = cat_window_size(1920, 1080, 1)
        helper.draw_cat(40, True, playful=False, growth=1, width=width, height=height)
        large = helper.canvas.ovals[0]
        self.assertGreater(large[2] - large[0], (small[2] - small[0]) * 5,
                           "the cat itself grows, including with decorative motion off")
        self.assertTrue(all(0 <= x <= width for oval in helper.canvas.ovals for x in (oval[0], oval[2])))
        self.assertTrue(all(0 <= y <= height for oval in helper.canvas.ovals for y in (oval[1], oval[3])))

    def test_bad_duration_pauses_resets_and_never_counts_unobserved_time(self):
        timer = PostureDuration()
        timer.update(40, 0)
        for t in range(1, 21):
            timer.update(40, t)
        self.assertEqual(timer.seconds, 20)
        timer.update(65, 21)
        timer.update(65, 22)
        self.assertEqual(timer.seconds, 20)
        timer.update(40, 23)
        self.assertEqual(timer.update(40, 24), 21)
        self.assertEqual(timer.update(75, 25), 0)
        for t in range(26, 40):
            timer.update(40, t)
        self.assertEqual(timer.update(None, 40), 0)
        timer.update(40, 41)
        timer.update(40, 42)
        self.assertEqual(timer.update(40, 1000), 0, "sleep is not bad posture")

    def test_close_face_has_exact_warning_and_optional_zoom_hint(self):
        helper = object.__new__(DesktopCat)
        helper.canvas = FakeCanvas()
        helper.draw_cat(None, False, face_close=True)
        self.assertIn("顔が近い", helper.canvas.texts)
        self.assertNotIn("文字、小さくない？", helper.canvas.texts)
        helper.draw_cat(None, False, face_close=True, zoom_hint=True)
        self.assertIn("顔が近い", helper.canvas.texts)
        self.assertIn("文字、小さくない？", helper.canvas.texts)
        helper.draw_cat(100, False, face_close=False, zoom_hint=True)
        self.assertNotIn("顔が近い", helper.canvas.texts)
        self.assertNotIn("文字、小さくない？", helper.canvas.texts)

    def test_poll_animation_and_skip_work_with_decorative_motion_disabled(self):
        helper = object.__new__(DesktopCat)
        helper.root, helper.canvas = FakeRoot(), FakeCanvas()
        helper.visible = False
        helper.suppressed_until = helper.pause_suppressed_until = 0
        helper.blocked_since = None
        helper.duration = PostureDuration()
        helper.current_growth = 0
        helper.current_scale = cat_scale(100)
        helper.window_width, helper.window_height = 328, 232
        helper.anchor_right, helper.anchor_bottom = 1896, 1010
        helper.started_at = 0
        state = dict(score=40, active=True, playful=False,
                     pause_on_kittens=False, grow=True, face_close=False)
        with patch("desktop_guard.fetch_state", return_value=state), \
             patch("desktop_guard.report_dismiss") as dismiss_mock, \
             patch("desktop_guard.time.monotonic") as clock:
            for tick in range(100):
                clock.return_value = 10 + tick * .5
                helper.poll()
                helper.animate()
            self.assertTrue(helper.visible)
            self.assertAlmostEqual(helper.current_growth, 1, delta=.002)
            self.assertGreater(helper.window_width, 1000)
            helper.skip()
            self.assertEqual(dismiss_mock.call_count, 1)
            self.assertFalse(helper.visible)
            self.assertEqual(helper.window_width, 328)
            clock.return_value += 1
            helper.poll()
            self.assertFalse(helper.visible)
            self.assertEqual(helper.bad_seconds, 0)
            clock.return_value += 121
            helper.poll()
            self.assertTrue(helper.visible)
            self.assertEqual(helper.bad_seconds, 0, "hidden time does not grow the cat")
            state.update(score=None, face_close=True, zoom_hint=True)
            clock.return_value += .5
            helper.poll()
            helper.animate()
            self.assertTrue(helper.visible, "face-only warning still has a window")
            self.assertIn("顔が近い", helper.canvas.texts)
            self.assertIn("文字、小さくない？", helper.canvas.texts)
            state.update(face_close=False, zoom_hint=False)
            clock.return_value += .5
            helper.poll()
            self.assertFalse(helper.visible, "camera loss hides both cat and warning")

    def test_child_cats_are_capped_and_recover(self):
        self.assertEqual(kitten_count(44, 4.9), 0)
        self.assertEqual(kitten_count(44, 5), 1)
        self.assertEqual(kitten_count(44, 13), 2)
        self.assertEqual(kitten_count(0, 500), 2)
        self.assertEqual(kitten_count(70, 500), 0)
        self.assertEqual(kitten_count(30, 500, playful=False), 0)
        self.assertEqual(kitten_count(None, 500), 0)

    def test_playful_cat_draws_more_elements_without_disturbing_caption(self):
        helper = object.__new__(DesktopCat)
        helper.canvas = FakeCanvas()
        helper.draw_cat(42, True, playful=True, bad_seconds=15, elapsed=8)
        self.assertGreater(len(helper.canvas.ovals), 15, "main cat and two kittens")
        self.assertIn("背すじを少し楽に伸ばそう · 42点", helper.canvas.texts)
        helper.draw_cat(42, True, playful=False, bad_seconds=500, elapsed=8)
        self.assertLess(len(helper.canvas.ovals), 10, "motion-off only draws the main cat")

    def test_screen_pause_starts_at_two_total_cats_and_is_optional(self):
        self.assertFalse(should_pause_for_kittens(40, 4.9, True, True))
        self.assertTrue(should_pause_for_kittens(40, 5.0, True, True))
        self.assertTrue(should_pause_for_kittens(40, 13, True, True))
        self.assertFalse(should_pause_for_kittens(70, 15, True, True))
        self.assertFalse(should_pause_for_kittens(40, 15, False, True))
        self.assertFalse(should_pause_for_kittens(40, 15, True, False))

    def test_overlay_releases_on_recovery_and_has_timed_escape(self):
        helper = object.__new__(DesktopCat)
        helper.root, helper.blocker, helper.pause_message = (
            FakeRoot(), FakeBlocker(), FakeText())
        helper.score, helper.playful, helper.pause_on_kittens = (40, True, True)
        helper.blocked_since = None
        helper.block_generation = 0
        helper.pause_suppressed_until = 0
        helper.suppressed_until = 0

        helper.update_block(10, 5)
        self.assertTrue(helper.blocker.showing)
        self.assertEqual(helper.blocked_since, 10)
        self.assertEqual(helper.root.callbacks[0][0], MAX_PAUSE_SECONDS * 1000)
        helper.update_block(11, 6)
        self.assertIn("Escで即解除", helper.pause_message.value)
        helper.score = 75
        helper.update_block(12, 6)
        self.assertFalse(helper.blocker.showing)
        self.assertIsNone(helper.blocked_since)

        helper.score = 40
        helper.update_block(20, 5)
        active_generation = helper.block_generation
        with patch("desktop_guard.time.monotonic", return_value=50):
            helper.timeout_block(active_generation)
        self.assertFalse(helper.blocker.showing)
        self.assertGreater(helper.pause_suppressed_until, 50)
        helper.update_block(51, 15)
        self.assertFalse(helper.blocker.showing, "the pause must not immediately re-lock")

        helper.grow = True
        helper.pause_suppressed_until = 0
        helper.update_block(200, 30)
        self.assertFalse(helper.blocker.showing, "a full-screen pause cannot cover giant-cat mode")


if __name__ == "__main__":
    unittest.main()
