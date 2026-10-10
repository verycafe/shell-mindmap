#!/usr/bin/env python3
"""Configuration and help workflows through the CLI and real terminal.

Python is only used by development tests. Every mm process has an empty tool
PATH and a temporary MM_CONFIG_FILE; these tests never change the user's HOME.
"""

import os
from pathlib import Path
import subprocess
import tempfile
import termios
import unittest

from test_pty import ENTRY, ESC, PAGE_DOWN, PAGE_UP, Terminal


F1 = b"\x1bOP"


class ConfigurationAndHelpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mm-cli-", dir="/tmp")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.config_file = self.directory / "settings.conf"
        self.env = dict(os.environ, PATH="/no-external-tools", LANG="en_US.UTF-8",
                        LC_ALL="en_US.UTF-8", MM_CONFIG_FILE=str(self.config_file))
        self.env.pop("MM_NODE_WIDTH", None)

    def cli(self, *arguments, success=True):
        result = subprocess.run(["/bin/zsh", "-f", str(ENTRY), *arguments],
                                env=self.env, cwd=self.directory, capture_output=True,
                                text=True, timeout=5)
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0,
                                "Invalid configuration was unexpectedly accepted")
            self.assertTrue(result.stdout.strip() or result.stderr.strip(),
                            "Invalid input should give a readable error")
        return result

    def terminal(self, filename=None, **kwargs):
        extra_env = dict(self.env)
        extra_env.update(kwargs.pop("env", {}))
        terminal = Terminal(filename, env=extra_env, **kwargs)
        self.addCleanup(terminal.close)
        return terminal

    def assert_exit(self, terminal):
        self.assertEqual(terminal.wait_exit(), 0)
        self.assertEqual(termios.tcgetattr(terminal.fd), terminal.original_termios)
        self.assertTrue(terminal.output.endswith(
            b"\x1b[0m\x1b[?2004l\x1b[?25h\x1b[?1049l"))

    def root_lines(self, terminal, original):
        lines = [line.strip() for line in terminal.canvas.splitlines() if line.strip()]
        self.assertEqual("".join(lines), original, terminal.canvas)
        return lines

    def test_cli_config_persists_resets_and_rejects_invalid_values_without_damage(self):
        save_dir = self.directory / "saved maps"
        save_dir.mkdir()
        self.assertEqual(self.cli("config", "path").stdout.strip(), str(self.config_file))
        self.cli("config", "set", "node-width", "40")
        self.cli("config", "set", "save-dir", str(save_dir))
        self.cli("keys", "bind", "help", "H")
        # Each CLI invocation is a new process, so these reads prove persistence.
        self.assertEqual(self.cli("config", "get", "node-width").stdout.strip(), "40")
        self.assertEqual(self.cli("config", "get", "save-dir").stdout.strip(), str(save_dir))
        self.assertEqual(self.cli("config", "get", "key.help").stdout.strip(), "H")
        self.assertIn("node-width", self.cli("config", "list").stdout)
        self.assertIn("H", self.cli("keys", "list").stdout)
        saved = self.config_file.read_bytes()
        self.cli("config", "set", "node-width", "3", success=False)
        self.assertEqual(self.config_file.read_bytes(), saved)
        self.cli("config", "set", "save-dir", str(self.directory / "missing"), success=False)
        self.assertEqual(self.config_file.read_bytes(), saved)
        self.cli("keys", "bind", "save", "e", success=False)
        self.assertEqual(self.config_file.read_bytes(), saved)
        self.cli("keys", "reset", "help")
        self.assertEqual(self.cli("config", "get", "key.help").stdout.strip(), "?")
        self.cli("config", "reset", "node-width")
        self.assertEqual(self.cli("config", "get", "node-width").stdout.strip(), "32")
        self.assertEqual(self.cli("config", "get", "save-dir").stdout.strip(), str(save_dir))

    def test_shell_metacharacters_in_config_are_literal_through_save_and_reload(self):
        marker = self.directory / "executed"
        self.env["MM_PTY_MARKER"] = str(marker)
        save_dir = self.directory / "$(print owned >${MM_PTY_MARKER})"
        save_dir.mkdir()
        self.cli("config", "set", "save-dir", str(save_dir))
        self.assertEqual(self.cli("config", "get", "save-dir").stdout.strip(), str(save_dir))
        self.assertFalse(marker.exists())
        terminal = self.terminal()
        terminal.send("字面路径测试\r")
        terminal.send("s")
        terminal.send("\r")
        terminal.send("q")
        self.assert_exit(terminal)
        filename = save_dir / "mindmap.mm"
        self.assertEqual(filename.read_text(), "MM-ZSH-1\n0\t0\t字面路径测试\n")
        reopened = self.terminal(filename)
        self.assertIn("字面路径测试", reopened.canvas)
        reopened.send("q")
        self.assert_exit(reopened)
        self.assertFalse(marker.exists(), "Configuration or path text executed shell code")

    def test_question_fullwidth_and_f1_help_stays_open_on_enter_and_scrolls(self):
        filename = self.directory / "help.mm"
        terminal = self.terminal(filename, rows=30, cols=110)
        title = "帮助测试原文"
        terminal.send(title + "\r")
        terminal.send("s")
        original = filename.read_bytes()
        for open_key, close_key in (("?", "?"), ("？", "？"), (F1, F1)):
            with self.subTest(open_key=open_key):
                terminal.send(open_key)
                self.assertNotIn(title, terminal.screen,
                                 "Help did not replace the map view")
                help_screen = terminal.screen
                terminal.send("\r")
                self.assertEqual(terminal.screen, help_screen,
                                 "Enter closed help or triggered a map command")
                terminal.send(close_key)
                self.assertIn(title, terminal.canvas)
        terminal.resize(12, 48)
        terminal.send("？")
        first_page = terminal.screen
        terminal.send(PAGE_DOWN)
        self.assertNotEqual(terminal.screen, first_page, "Help did not scroll in a short terminal")
        self.assertNotIn(title, terminal.screen)
        # Reach a stable last page, then return to the first without changing data.
        for _ in range(20):
            previous = terminal.screen
            terminal.send(PAGE_DOWN)
            if terminal.screen == previous:
                break
        else:
            self.fail("Help did not reach a bounded last page")
        for _ in range(20):
            terminal.send(PAGE_UP)
            if terminal.screen == first_page:
                break
        self.assertEqual(terminal.screen, first_page)
        terminal.send(ESC)
        self.assertIn(title, terminal.canvas)
        terminal.send("q")
        self.assert_exit(terminal)
        self.assertEqual(filename.read_bytes(), original)

    def test_cli_bound_help_key_is_used_by_footer_and_actual_help_after_restart(self):
        self.cli("keys", "bind", "help", "H")
        filename = self.directory / "keys.mm"
        terminal = self.terminal(filename, cols=120)
        title = "快捷键配置测试"
        terminal.send(title + "\r")
        self.assertRegex(terminal.screen, r"H[^\n]*帮助|帮助[^\n]*H")
        terminal.send("H")
        self.assertNotIn(title, terminal.screen)
        self.assertIn("H", terminal.screen)
        terminal.send(ESC)
        self.assertIn(title, terminal.canvas)
        terminal.send("sq")
        self.assert_exit(terminal)
        reopened = self.terminal(filename, sourced=True, cols=120)
        self.assertRegex(reopened.screen, r"H[^\n]*帮助|帮助[^\n]*H")
        reopened.send("H")
        self.assertNotIn(title, reopened.screen)
        reopened.send("q")
        self.assertIn(title, reopened.canvas, "q should close help before quitting the map")
        reopened.send("q")
        self.assert_exit(reopened)

    def test_default_save_directory_prefills_exact_filename_with_spaces(self):
        save_dir = self.directory / "my mind maps"
        save_dir.mkdir()
        self.cli("config", "set", "save-dir", str(save_dir))
        terminal = self.terminal(cols=160)
        terminal.send("默认位置\r")
        terminal.send("s")
        expected_file = save_dir / "mindmap.mm"
        self.assertIn(str(expected_file), terminal.screen)
        terminal.send("\r")
        self.assertTrue(expected_file.is_file(), terminal.screen)
        terminal.send("q")
        self.assert_exit(terminal)
        self.assertEqual(expected_file.read_text(), "MM-ZSH-1\n0\t0\t默认位置\n")
        self.assertFalse((self.directory / "mindmap.mm").exists())

    def test_colon_commands_apply_immediately_and_persist_without_executing_text(self):
        marker = self.directory / "executed"
        self.env["MM_PTY_MARKER"] = str(marker)
        save_dir = self.directory / "command maps $(print owned >${MM_PTY_MARKER})"
        save_dir.mkdir()
        original = "甲乙丙丁戊己庚辛壬癸" * 5
        terminal = self.terminal(rows=28, cols=120)
        terminal.send(original + "\r")
        self.assertEqual(len(self.root_lines(terminal, original)), 4)
        terminal.send(":set node-width 40\r")
        self.assertEqual(len(self.root_lines(terminal, original)), 3)
        terminal.send(":set save-dir '" + str(save_dir) + "'\r")
        terminal.send(":bind help H\r")
        self.assertRegex(terminal.screen, r"H[^\n]*帮助|帮助[^\n]*H")
        self.assertEqual(self.cli("config", "get", "node-width").stdout.strip(), "40")
        self.assertEqual(self.cli("config", "get", "save-dir").stdout.strip(), str(save_dir))
        self.assertEqual(self.cli("config", "get", "key.help").stdout.strip(), "H")
        self.assertFalse(marker.exists())
        settings = self.config_file.read_bytes()
        terminal.send(":set node-width 3\r")
        self.assertEqual(self.config_file.read_bytes(), settings)
        self.assertEqual(len(self.root_lines(terminal, original)), 3)
        terminal.send("H")
        self.assertNotIn(original[:16], terminal.screen)
        terminal.send(ESC)
        filename = save_dir / "chosen map.mm"
        terminal.send(":write '" + str(filename) + "'\r")
        self.assertEqual(filename.read_text(), f"MM-ZSH-1\n0\t0\t{original}\n")
        self.assertFalse(marker.exists(), "A colon command executed its quoted path")
        terminal.send(":quit\r")
        self.assert_exit(terminal)
        reopened = self.terminal(filename, sourced=True, rows=28, cols=120)
        self.assertEqual(len(self.root_lines(reopened, original)), 3)
        self.assertRegex(reopened.screen, r"H[^\n]*帮助|帮助[^\n]*H")
        reopened.send(":help\r")
        self.assertNotIn(original[:16], reopened.screen)
        reopened.send(ESC)
        reopened.send(":quit\r")
        self.assert_exit(reopened)
        self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
