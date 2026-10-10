#!/usr/bin/env python3
"""Focused PTY regression tests for the scrollable help module.

Observed on the pre-fix build, 2026-10-09, using a real PTY and saved map:
* ASCII '?' alone opened help successfully.
* Chinese full-width '？' left the map unchanged.
* Sending '?\\r' opened help then immediately closed it on Enter.
* At 12 rows only the first 11 help rows appeared; Down closed help instead of
  reaching the omitted save/quit/edit instructions.

Python is a development-only dependency. Each tested Zsh process receives an
unusable PATH and sources the real input, layout, and help modules.
Run: python3 tests/help_pty.py
"""

from pathlib import Path
import shlex
import tempfile
import unittest

import test_pty as pty_support


ROOT = Path(__file__).resolve().parents[1]
F1 = b"\x1bOP"


class HelpPTYTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="mm-help-pty-")
        cls.previous_entry = pty_support.ENTRY
        cls.entry = Path(cls.temp.name) / "help-harness.zsh"
        sources = "\n".join(
            "source " + shlex.quote(str(ROOT / "src" / name))
            for name in ("layout.zsh", "ui.zsh", "help.zsh")
        )
        cls.entry.write_text(
            "emulate -LR zsh\n"
            "setopt multibyte\n"
            "typeset +x COLUMNS LINES\n"
            + sources
            + "\n"
            "_test_help() {\n"
            "  local -A mm_config=(save-dir '/tmp/脑图 目录' node-width 40 "
            "key.help H key.child A key.save w)\n"
            "  local mm_config_file='/tmp/mm-help-config.conf' REPLY=''\n"
            "  local -i mm_running=1 mm_interrupted=0 mm_wrap_width=48\n"
            "  _mm_help_screen \"${1:-keys}\"\n"
            "  print -rn -- $'\\e[H\\e[2J'\n"
            "  print -r -- 'HELP CLOSED'\n"
            "}\n"
            "_test_help \"$@\"\n",
            encoding="utf-8",
        )
        pty_support.ENTRY = cls.entry

    @classmethod
    def tearDownClass(cls):
        pty_support.ENTRY = cls.previous_entry
        cls.temp.cleanup()

    def terminal(self, topic="keys", **kwargs):
        terminal = pty_support.Terminal(topic, **kwargs)
        self.addCleanup(terminal.close)
        return terminal

    def test_enter_keeps_help_and_each_close_key_returns(self):
        for close_key in ("?", "？", F1, pty_support.ESC, "q", b"\x03"):
            with self.subTest(close_key=close_key):
                terminal = self.terminal(rows=12, cols=70)
                self.assertIn("mm 帮助", terminal.screen)
                terminal.send("\r")
                self.assertIn("mm 帮助", terminal.screen, terminal.screen)
                terminal.send(close_key)
                self.assertIn("HELP CLOSED", terminal.screen, terminal.screen)
                self.assertEqual(terminal.wait_exit(), 0)

    def test_all_help_pages_accessible_at_twelve_rows(self):
        terminal = self.terminal(rows=12, cols=70)
        self.assertIn("A    添加子节点", terminal.screen)
        terminal.send(pty_support.PAGE_DOWN)
        self.assertIn("选择与滚动", terminal.screen, terminal.screen)
        terminal.send(b"\x1b[F")
        self.assertIn("Enter 不关闭帮助", terminal.screen, terminal.screen)
        terminal.send(b"\x1b[H")
        self.assertIn("创建与编辑", terminal.screen, terminal.screen)
        terminal.send(pty_support.DOWN)
        self.assertNotIn("创建与编辑", terminal.screen, terminal.screen)
        terminal.send(pty_support.UP)
        self.assertIn("创建与编辑", terminal.screen, terminal.screen)
        terminal.send("\t")
        self.assertIn("[配置]", terminal.screen)
        self.assertIn("保存目录：/tmp/脑图 目录", terminal.screen)
        self.assertIn("本次使用：48", terminal.screen)
        self.assertIn("/tmp/mm-help-config.conf", terminal.screen)
        terminal.send(b"\x1b[F")
        self.assertIn("不能解绑", terminal.screen, terminal.screen)
        terminal.send(pty_support.RIGHT)
        self.assertIn("[命令]", terminal.screen)
        self.assertIn(":help", terminal.screen)
        terminal.send(b"\x1b[F")
        self.assertIn("自定义主键优先", terminal.screen, terminal.screen)
        terminal.send(pty_support.LEFT)
        self.assertIn("[配置]", terminal.screen)

    def test_resize_rewraps_config_without_closing(self):
        terminal = self.terminal("config", rows=26, cols=100)
        self.assertIn("[配置]", terminal.screen)
        terminal.resize(12, 48)
        self.assertIn("mm 帮助", terminal.screen)
        self.assertIn("[配置]", terminal.screen)
        terminal.send(b"\x1b[F")
        self.assertIn("不能解绑", terminal.screen, terminal.screen)
        terminal.resize(20, 90)
        self.assertIn("mm 帮助", terminal.screen)
        terminal.send(b"\x1b[H")
        self.assertIn("/tmp/mm-help-config.conf", terminal.screen)


if __name__ == "__main__":
    unittest.main(verbosity=2)
