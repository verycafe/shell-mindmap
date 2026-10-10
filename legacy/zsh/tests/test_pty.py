#!/usr/bin/env python3
"""End-to-end terminal tests. Python is a development-only test dependency.

Run: python3 tests/test_pty.py
The actual application is always started with an unusable PATH to ensure it
does not quietly depend on PHP, stty, tput, or another external command.
"""

import errno
import fcntl
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time
import unicodedata
import unittest


ENTRY = Path(__file__).resolve().parents[1] / "mm.zsh"
LEFT = b"\x1b[D"
RIGHT = b"\x1b[C"
UP = b"\x1b[A"
DOWN = b"\x1b[B"
HOME = b"\x1b[H"
PAGE_UP = b"\x1b[5~"
PAGE_DOWN = b"\x1b[6~"
ESC = b"\x1b"
CSI = re.compile(r"\x1b\[([0-9;?]*)([@-~])")


def display_width(text):
    return sum(0 if unicodedata.combining(ch) else
               2 if unicodedata.east_asian_width(ch) in "WF" else 1
               for ch in text)


def column_slice(text, start, width):
    """Read a screen region in terminal columns, including wide Chinese text."""
    result = []
    column = 0
    for ch in text:
        char_width = display_width(ch)
        if start <= column and column + char_width <= start + width:
            result.append(ch)
        column += char_width
        if column >= start + width:
            break
    return "".join(result).rstrip()


def visible_screen(raw, rows, cols):
    """Small ANSI screen reader for the cursor/erase/color sequences mm emits."""
    text = raw.decode("utf-8", "replace")
    last_frame = text.rfind("\x1b[H\x1b[2J")
    if last_frame >= 0:
        text = text[last_frame:]
    cells = [[" " for _ in range(cols)] for _ in range(rows)]
    y = x = i = 0
    while i < len(text):
        if text[i] == "\x1b":
            match = CSI.match(text, i)
            if not match:
                i += 1
                continue
            arg, command = match.groups()
            numbers = [int(value or 0) for value in arg.lstrip("?").split(";")]
            if command in "Hf":
                y = max(0, (numbers[0] or 1) - 1)
                x = max(0, (numbers[1] if len(numbers) > 1 else 1) - 1)
            elif command == "J" and numbers[0] == 2:
                cells = [[" " for _ in range(cols)] for _ in range(rows)]
            elif command == "K" and 0 <= y < rows:
                if numbers[0] == 2:
                    cells[y] = [" " for _ in range(cols)]
                elif numbers[0] == 0:
                    cells[y][min(x, cols):] = [" "] * max(0, cols - x)
            i = match.end()
            continue
        ch = text[i]
        i += 1
        if ch == "\r":
            x = 0
            continue
        if ch == "\n":
            y += 1
            continue
        if ord(ch) < 32:
            continue
        width = 0 if unicodedata.combining(ch) else (
            2 if unicodedata.east_asian_width(ch) in "WF" else 1
        )
        if width == 0:
            if 0 <= y < rows and 0 < x <= cols:
                cells[y][x - 1] += ch
            continue
        if x >= cols:
            x = 0
            y += 1
        if 0 <= y < rows and x < cols:
            cells[y][x] = ch
            if width == 2 and x + 1 < cols:
                cells[y][x + 1] = ""
        x += width
    return "\n".join("".join(row).rstrip() for row in cells)


class Terminal:
    def __init__(self, filename=None, *, rows=26, cols=100, sourced=False, env=None):
        self.rows, self.cols = rows, cols
        self.output = bytearray()
        self.exit_status = None
        self.closed = False
        self.config_temp = None
        if not (env or {}).get("MM_CONFIG_FILE"):
            self.config_temp = tempfile.TemporaryDirectory(prefix="mm-pty-config-", dir="/tmp")
        config_file = ((env or {}).get("MM_CONFIG_FILE") or
                       str(Path(self.config_temp.name) / "settings.conf"))
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            child_env = os.environ.copy()
            child_env.pop("MM_NODE_WIDTH", None)
            child_env["MM_CONFIG_FILE"] = config_file
            child_env.update(env or {})
            child_env.update(PATH="/no-external-tools", TERM="xterm-256color",
                             LANG="en_US.UTF-8", LC_ALL="en_US.UTF-8")
            if sourced:
                args = ["/bin/zsh", "-f", "-c", 'source "$1"; mm "${@:2}"',
                        "pty-mm-test", str(ENTRY)]
            else:
                args = ["/bin/zsh", "-f", str(ENTRY)]
            if filename is not None:
                args.append(str(filename))
            os.execve(args[0], args, child_env)
        self.original_termios = termios.tcgetattr(self.fd)
        self.settle()

    def settle(self, *, quiet=0.16, maximum=8):
        deadline = time.monotonic() + maximum
        last_read = time.monotonic()
        while time.monotonic() < deadline:
            remaining = min(quiet, max(0, deadline - time.monotonic()))
            ready, _, _ = select.select([self.fd], [], [], remaining)
            if ready:
                try:
                    chunk = os.read(self.fd, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not chunk:
                    break
                self.output.extend(chunk)
                last_read = time.monotonic()
            elif time.monotonic() - last_read >= quiet:
                break
        return self.screen

    @property
    def screen(self):
        return visible_screen(self.output, self.rows, self.cols)

    @property
    def canvas(self):
        return "\n".join(self.screen.splitlines()[3:self.rows - 4])

    def send(self, text):
        payload = text.encode("utf-8") if isinstance(text, str) else text
        while payload:
            count = os.write(self.fd, payload)
            payload = payload[count:]
        return self.settle()

    def resize(self, rows, cols):
        self.rows, self.cols = rows, cols
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        os.killpg(os.tcgetpgrp(self.fd), signal.SIGWINCH)
        return self.settle(quiet=1.15, maximum=2.5)

    def wait_exit(self, timeout=5):
        deadline = time.monotonic() + timeout
        while self.exit_status is None and time.monotonic() < deadline:
            self.settle(quiet=0.04, maximum=0.1)
            child, status = os.waitpid(self.pid, os.WNOHANG)
            if child:
                self.exit_status = os.waitstatus_to_exitcode(status)
                break
        if self.exit_status is None:
            raise AssertionError("Application did not exit. Last screen:\n" + self.screen)
        return self.exit_status

    def close(self):
        if self.closed:
            return
        if self.exit_status is None:
            try:
                os.killpg(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                os.waitpid(self.pid, 0)
            except ChildProcessError:
                pass
        os.close(self.fd)
        self.closed = True
        if self.config_temp is not None:
            self.config_temp.cleanup()


class MindMapPTYTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mm-pty-", dir="/tmp")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def terminal(self, *args, **kwargs):
        terminal = Terminal(*args, **kwargs)
        self.addCleanup(terminal.close)
        return terminal

    def assert_text(self, terminal, expected):
        self.assertIn(expected, terminal.screen, terminal.screen)

    def assert_node_visible(self, terminal, original, width):
        """Reassemble one actual drawn node, without looking at layout internals."""
        lines = terminal.canvas.splitlines()
        marker = original[:4]
        matches = [(row, line.index(marker)) for row, line in enumerate(lines)
                   if marker in line]
        self.assertEqual(len(matches), 1, terminal.canvas)
        first_row, offset = matches[0]
        column = display_width(lines[first_row][:offset])
        pieces, drawn_rows = [], []
        for row in range(first_row, len(lines)):
            piece = column_slice(lines[row], column, width).rstrip(" ─│┌┐└┘├┤┬┴┼")
            self.assertTrue(piece, "A wrapped node contains an empty/covered line:\n" +
                            terminal.canvas)
            pieces.append(piece)
            drawn_rows.append(row)
            if len("".join(pieces)) >= len(original):
                break
        self.assertEqual("".join(pieces), original,
                         "Visible wrapped text is missing, truncated or overwritten:\n" +
                         terminal.canvas)
        return column, drawn_rows, pieces

    def assert_clean_exit(self, terminal):
        self.assertEqual(terminal.wait_exit(), 0, terminal.output.decode("utf-8", "replace"))
        self.assertEqual(termios.tcgetattr(terminal.fd), terminal.original_termios,
                         "Terminal input/echo settings were not restored")
        self.assertIn(b"\x1b[?1049h", terminal.output)
        self.assertTrue(terminal.output.endswith(
            b"\x1b[0m\x1b[?2004l\x1b[?25h\x1b[?1049l"),
            "Alternate screen, cursor and bracketed paste were not restored")

    def test_chinese_edit_branches_undo_save_and_source_reopen(self):
        filename = self.directory / "中文脑图.mm"
        terminal = self.terminal(filename)
        self.assert_text(terminal, "中心主题")
        terminal.send("中文脑图\r")
        terminal.send("\t产品方向\r")
        terminal.send("\r技术方案\r")
        # Cursor movement and deletion must work in characters, not UTF-8 bytes.
        terminal.send("e\x15后端开发")
        terminal.send(LEFT + b"\x7f" + "研\r".encode())
        self.assert_text(terminal, "后端研发")
        terminal.send("\t数据库\r")
        terminal.send("d")
        self.assertNotIn("数据库", terminal.canvas)
        terminal.send("u")
        self.assertIn("数据库", terminal.canvas)
        terminal.send("r")
        self.assertNotIn("数据库", terminal.canvas)
        terminal.send("u")
        self.assertIn("数据库", terminal.canvas)
        for label in ("中文脑图", "产品方向", "后端研发"):
            self.assertIn(label, terminal.canvas)
        self.assertRegex(terminal.canvas, "[┌├└┬┴┼┤]")
        self.assertIn("─", terminal.canvas)
        terminal.send("s")
        expected = "MM-ZSH-1\n0\t0\t中文脑图\n1\t0\t产品方向\n1\t0\t后端研发\n2\t0\t数据库\n"
        self.assertEqual(filename.read_text(), expected)
        terminal.send("q")
        self.assert_clean_exit(terminal)

        reopened = self.terminal(filename, sourced=True)
        for label in ("中文脑图", "产品方向", "后端研发", "数据库"):
            self.assertIn(label, reopened.canvas)
        reopened.send(" ")
        self.assertNotIn("产品方向", reopened.canvas)
        self.assertNotIn("数据库", reopened.canvas)
        reopened.send(RIGHT)
        self.assertIn("产品方向", reopened.canvas)
        self.assertIn("数据库", reopened.canvas)
        reopened.send("s")
        self.assertEqual(filename.read_text(), expected)
        reopened.send("q")
        self.assert_clean_exit(reopened)

    def test_unsaved_quit_cancel_then_save_to_chosen_filename(self):
        filename = self.directory / "另存脑图.mm"
        terminal = self.terminal()
        terminal.send("临时中心\r")
        terminal.send("\t保留内容\r")
        terminal.send("q")
        self.assert_text(terminal, "未保存")
        terminal.send(ESC)
        self.assertIn("保留内容", terminal.canvas)
        terminal.send("qs")
        self.assert_text(terminal, "保存到文件")
        terminal.send("\x15" + str(filename) + "\r")
        self.assert_clean_exit(terminal)
        self.assertEqual(filename.read_text(),
                         "MM-ZSH-1\n0\t0\t临时中心\n1\t0\t保留内容\n")

    def test_shell_metacharacters_are_data_during_entry_save_and_load(self):
        filename = self.directory / "literal.mm"
        marker = self.directory / "executed"
        command_substitution = f"$(print owned > {marker})"
        backticks = f"`print owned > {marker}`"
        terminal = self.terminal(filename)
        terminal.send(command_substitution + "\r")
        terminal.send("\t" + backticks + "\r")
        terminal.send("s")
        self.assertFalse(marker.exists(), "Node text was executed as shell code")
        saved = filename.read_text()
        self.assertIn(command_substitution, saved)
        self.assertIn(backticks, saved)
        terminal.send("q")
        self.assert_clean_exit(terminal)
        reopened = self.terminal(filename, sourced=True)
        self.assertFalse(marker.exists(), "Loading a map executed node text")
        reopened.send("sq")
        self.assert_clean_exit(reopened)
        self.assertEqual(filename.read_text(), saved)
        self.assertFalse(marker.exists())

    def test_resize_recovers_from_narrow_terminal_and_quit_restores_state(self):
        terminal = self.terminal(rows=9, cols=38)
        self.assert_text(terminal, "请将终端放大")
        terminal.send("窗口恢复\r")
        terminal.resize(26, 100)
        self.assertIn("窗口恢复", terminal.canvas)
        terminal.send("\t可继续编辑\r")
        self.assertIn("可继续编辑", terminal.canvas)
        terminal.resize(10, 35)
        self.assert_text(terminal, "请将终端放大")
        terminal.resize(26, 100)
        self.assertIn("可继续编辑", terminal.canvas)
        terminal.send("qd")
        self.assert_clean_exit(terminal)

    def test_ctrl_c_cancels_edit_without_losing_saved_map(self):
        filename = self.directory / "cancel.mm"
        terminal = self.terminal(filename)
        terminal.send("保留原文\r")
        terminal.send("s")
        original = filename.read_text()
        terminal.send("e\x15丢弃这段编辑")
        terminal.send(b"\x03")
        self.assertIn("保留原文", terminal.canvas)
        self.assertNotIn("丢弃这段编辑", terminal.canvas)
        self.assertNotIn("编辑节点 ·", terminal.screen,
                         "Ctrl-C must cancel the editor without needing a second key")
        terminal.send("q")
        self.assert_clean_exit(terminal)
        self.assertEqual(filename.read_text(), original)

    def test_bracketed_paste_is_text_and_cannot_trigger_commands(self):
        filename = self.directory / "paste.mm"
        terminal = self.terminal(filename)
        terminal.send("粘贴测试\r")
        terminal.send("\t")
        terminal.send(b"\x1b[200~" + "第一行\n第二行\tqd".encode() + b"\x1b[201~")
        terminal.send("\r")
        self.assertIn("第一行 第二行 qd", terminal.canvas)
        terminal.send("s")
        original = filename.read_text()
        # A pasted d/q outside the editor must neither delete nor quit.
        terminal.send(b"\x1b[200~dqu\t\x1b[201~")
        self.assertIn("第一行 第二行 qd", terminal.canvas)
        self.assertNotIn("未保存修改", terminal.screen)
        terminal.send("sq")
        self.assert_clean_exit(terminal)
        self.assertEqual(filename.read_text(), original)
        self.assertIn("1\t0\t第一行 第二行 qd\n", original)

    def test_long_mixed_chinese_siblings_wrap_without_truncation_or_overlap(self):
        filename = self.directory / "长句脑图.mm"
        first = "AI模型的输出可以自动整理成脑图，让用户专注输入想法和调整分支结构，同时完整保留长句中的每一个字。"
        second = "用户只需要输入内容，CLI就会自动连接各个节点并安排位置，阅读时不用打开另一扇窗口，也不必删减想法。"
        terminal = self.terminal(filename, rows=36, cols=110)
        terminal.send("长句脑图\r")
        terminal.send("\t" + first + "\r")
        terminal.send("\r" + second + "\r")
        first_col, first_rows, first_lines = self.assert_node_visible(terminal, first, 32)
        second_col, second_rows, second_lines = self.assert_node_visible(terminal, second, 32)
        self.assertGreater(len(first_lines), 1)
        self.assertGreater(len(second_lines), 1)
        self.assertEqual(first_col, second_col)
        self.assertLess(first_rows[-1], second_rows[0], terminal.canvas)
        self.assertNotIn("…", terminal.canvas)
        terminal.send("sq")
        self.assert_clean_exit(terminal)
        self.assertEqual(filename.read_text(),
                         f"MM-ZSH-1\n0\t0\t长句脑图\n1\t0\t{first}\n1\t0\t{second}\n")

    def test_long_parent_and_children_reflow_on_resize_and_keep_saved_text(self):
        filename = self.directory / "分支折行.mm"
        parent = "这是父主题，用AI自动整理终端里的信息并保持全部中文段落能够直接阅读。"
        first = "甲分支记录技术方案的完整说明以及用户需要理解的交互方式。"
        second = "乙分支记录保存文件和重新打开脑图时应当保留的原始内容。"
        terminal = self.terminal(filename, rows=34, cols=100,
                                 env={"MM_NODE_WIDTH": "24"})
        terminal.send(parent + "\r")
        terminal.send("\t" + first + "\r")
        terminal.send("\r" + second + "\r")
        parent_col, _, parent_lines = self.assert_node_visible(terminal, parent, 24)
        first_col, first_rows, _ = self.assert_node_visible(terminal, first, 24)
        second_col, second_rows, second_lines = self.assert_node_visible(terminal, second, 24)
        self.assertLess(parent_col + max(map(display_width, parent_lines)), first_col)
        self.assertEqual(first_col, second_col)
        self.assertLess(first_rows[-1], second_rows[0], terminal.canvas)
        self.assertGreater(len(parent_lines), 1)
        terminal.send("sq")
        self.assert_clean_exit(terminal)
        expected = f"MM-ZSH-1\n0\t0\t{parent}\n1\t0\t{first}\n1\t0\t{second}\n"
        self.assertEqual(filename.read_text(), expected)

        reopened = self.terminal(filename, rows=34, cols=100, sourced=True,
                                 env={"MM_NODE_WIDTH": "80"})
        # Wide nodes may occupy separate horizontal viewports. Selection must
        # reveal each full node; fitting the whole tree at once is not required.
        self.assert_node_visible(reopened, parent, 80)
        reopened.send(RIGHT)
        self.assert_node_visible(reopened, first, 80)
        reopened.send(DOWN)
        _, _, wide_second = self.assert_node_visible(reopened, second, 80)
        reopened.resize(34, 48)
        # At 48 terminal columns the 80-column preference is clamped to 44.
        _, _, narrow_second = self.assert_node_visible(reopened, second, 44)
        self.assertGreater(len(narrow_second), len(wide_second))
        reopened.send(LEFT)
        self.assert_node_visible(reopened, parent, 44)
        reopened.send(RIGHT)
        self.assert_node_visible(reopened, first, 44)
        self.assertNotIn("…", reopened.canvas)
        reopened.send("sq")
        self.assert_clean_exit(reopened)
        self.assertEqual(filename.read_text(), expected)

    def test_300_character_node_can_page_to_end_and_back_in_short_viewport(self):
        filename = self.directory / "高节点.mm"
        original = "开头检查" + "内容" * 146 + "末尾验证"
        self.assertEqual(len(original), 300)
        terminal = self.terminal(filename, rows=12, cols=70)
        terminal.send(original + "\r")
        self.assertIn("开头检查", terminal.canvas)
        self.assertNotIn("末尾验证", terminal.canvas)
        self.assertNotIn("…", terminal.canvas)
        for _ in range(12):
            if "末尾验证" in terminal.canvas:
                break
            terminal.send(PAGE_DOWN)
        self.assertIn("末尾验证", terminal.canvas,
                      "PageDown never revealed the end of a 300-character node")
        self.assertNotIn("开头检查", terminal.canvas)
        for _ in range(12):
            if "开头检查" in terminal.canvas:
                break
            terminal.send(PAGE_UP)
        self.assertIn("开头检查", terminal.canvas,
                      "PageUp never returned to the start of the tall node")
        self.assertNotIn("末尾验证", terminal.canvas)
        terminal.send("\t子节点追随\r")
        self.assertIn("子节点追随", terminal.canvas,
                      "Creating/selecting a node should bring it into the viewport")
        terminal.send("sq")
        self.assert_clean_exit(terminal)
        self.assertEqual(filename.read_text(),
                         f"MM-ZSH-1\n0\t0\t{original}\n1\t0\t子节点追随\n")

    def test_noninteractive_help_and_non_tty_error_without_external_path(self):
        env = dict(os.environ, PATH="/no-external-tools", LANG="en_US.UTF-8",
                   MM_CONFIG_FILE=str(self.directory / "settings.conf"))
        help_result = subprocess.run(["/bin/zsh", "-f", str(ENTRY), "--help"],
                                     env=env, capture_output=True, text=True, timeout=5)
        self.assertEqual(help_result.returncode, 0, help_result.stderr)
        self.assertIn("mm", help_result.stdout)
        error_result = subprocess.run(["/bin/zsh", "-f", str(ENTRY)],
                                      env=env, capture_output=True, text=True, timeout=5)
        self.assertNotEqual(error_result.returncode, 0)
        self.assertIn("交互终端", error_result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
