#!/usr/bin/env python3
"""Real PTY acceptance checks. All personal files/configuration live in temporary HOME."""
import base64
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which('node')
ESC = '\x1b'
ENTER = '\r'
LEFT = ESC + '[D'
RIGHT = ESC + '[C'
UP = ESC + '[A'
DOWN = ESC + '[B'
SHIFT_LEFT = ESC + '[1;2D'
SHIFT_RIGHT = ESC + '[1;2C'
SHIFT_UP = ESC + '[1;2A'
SHIFT_DOWN = ESC + '[1;2B'
F1 = ESC + 'OP'
CTRL_U = '\x15'
CTRL_F = '\x06'
CTRL_C = '\x03'
CTRL_R = '\x12'
BACKSPACE = '\x7f'
PAGE_UP = ESC + '[5~'
PAGE_DOWN = ESC + '[6~'
HOME = ESC + '[H'
END = ESC + '[F'


class Terminal:
    def __init__(self, home, filename=None, columns=80, rows=24, cwd=None):
        self.home = Path(home)
        self.cwd = Path(cwd) if cwd is not None else self.home / '工作目录'
        self.cwd.mkdir(parents=True, exist_ok=True)
        self.master, self.slave = pty.openpty()
        self.initial_mode = termios.tcgetattr(self.slave)
        self.columns, self.rows = columns, rows
        self.events = []
        self.raw = bytearray()
        self.initial_columns, self.initial_rows = columns, rows
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
        environment = os.environ.copy()
        for key in ('MM_CONFIG_FILE', 'MM_NODE_WIDTH', 'CI', 'INK_SCREEN_READER', 'NODE_OPTIONS'):
            environment.pop(key, None)
        environment.update(HOME=str(home), USERPROFILE=str(home), XDG_CONFIG_HOME=str(self.home / '.config'),
                           TERM='xterm-256color', FORCE_COLOR='1', NO_COLOR='', LANG='en_US.UTF-8')
        environment.pop('NO_COLOR', None)
        self.environment = environment
        command = [NODE, str(ROOT / 'bin' / 'SMM.js')]
        if filename is not None:
            command.append(str(filename))
        self.process = subprocess.Popen(command, cwd=self.cwd, env=environment, stdin=self.slave,
                                        stdout=self.slave, stderr=self.slave, start_new_session=True)
        self.drain(0.3)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)
        self.drain(0.02)
        os.close(self.master)
        os.close(self.slave)

    def drain(self, timeout=0.12):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            ready, _, _ = select.select([self.master], [], [], max(0, deadline - time.monotonic()))
            if not ready:
                break
            try:
                data = os.read(self.master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            self.raw.extend(data)
            self.events.append({'data': base64.b64encode(data).decode('ascii')})

    def send(self, value, settle=0.08):
        if self.process.poll() is not None:
            raise AssertionError('Application exited before input: ' + repr(value) + '\n' + self.screen())
        os.write(self.master, value.encode('utf-8') if isinstance(value, str) else value)
        self.drain(settle)

    def paste(self, text):
        self.send(ESC + '[200~' + text + ESC + '[201~')

    def snapshot(self, attributes=False):
        self.drain(0.02)
        result = subprocess.run([NODE, str(ROOT / 'tests' / 'terminal-screen.mjs')],
                                input=json.dumps({'columns': self.initial_columns, 'rows': self.initial_rows,
                                                  'events': self.events, 'attributes': attributes}), text=True, capture_output=True, check=True)
        return json.loads(result.stdout)

    def screen(self):
        return '\n'.join(self.snapshot()['lines'])

    def expect(self, text, timeout=3):
        deadline = time.monotonic() + timeout
        while True:
            actual = self.screen()
            if text in actual:
                return actual
            if time.monotonic() >= deadline or self.process.poll() is not None:
                raise AssertionError(f'Expected {text!r}, exit={self.process.poll()}:\n{actual}')
            self.drain(0.1)

    def absent(self, text):
        actual = self.screen()
        if text in actual:
            raise AssertionError(f'Unexpected {text!r}:\n{actual}')

    def command(self, value):
        self.send(':')
        self.expect('命令')
        self.send(value)
        self.send(ENTER)

    def cli(self, arguments):
        result = subprocess.run([NODE, str(ROOT / 'bin' / 'SMM.js'), *arguments], cwd=self.cwd,
                                env=self.environment, text=True, capture_output=True, timeout=10)
        if result.returncode != 0:
            raise AssertionError(result.stderr)
        return result.stdout

    def replace(self, text):
        self.send(CTRL_U)
        self.send(text)
        self.send(ENTER)

    def resize(self, columns, rows):
        self.drain(0.03)
        self.events.append({'columns': columns, 'rows': rows})
        self.columns, self.rows = columns, rows
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
        self.process.send_signal(signal.SIGWINCH)
        self.drain(0.15)

    def exited_cleanly(self):
        deadline = time.monotonic() + 4
        while self.process.poll() is None and time.monotonic() < deadline:
            # Keep reading while waiting: macOS PTY output has a small buffer and
            # a final repaint can otherwise block the application's clean exit.
            self.drain(0.05)
        self.process.wait(timeout=0.5)
        self.drain(0.05)
        assert self.process.returncode == 0, f'exit={self.process.returncode}\n{self.screen()}'
        assert termios.tcgetattr(self.slave) == self.initial_mode, 'TTY modes were not restored'
        assert b'\x1b[?1049h' in self.raw and b'\x1b[?1049l' in self.raw, 'alternate screen was not restored'
        assert b'\x1b[?25h' in self.raw, 'terminal cursor was not restored'
        assert b'\x1b[?2004l' in self.raw, 'bracketed paste mode was not released'
        assert self.snapshot()['buffer'] == 'normal', 'terminal remained in alternate buffer'


def records(file):
    lines = Path(file).read_text(encoding='utf-8').splitlines()
    assert lines.pop(0) == 'MM-ZSH-1'
    return [(int(depth), bool(int(folded)), text) for depth, folded, text in (line.split('\t', 2) for line in lines)]


def canvas_position(app, label, editing=False):
    """Find an ASCII fixture label in the rendered canvas, excluding UI text."""
    snapshot = app.snapshot()
    end = app.rows - (6 if editing else 4)
    positions = [(line.index(label), y) for y, line in enumerate(snapshot['lines'][3:end], start=3)
                 if label in line]
    assert len(positions) <= 1, f'Ambiguous canvas label {label!r}: {positions}'
    return positions[0] if positions else None


def palette_selection(app):
    snapshot = app.snapshot()
    rows = snapshot['lines'][3:app.rows - 6]
    selected = [line.strip() for line in rows if line.lstrip().startswith('› /')]
    assert len(selected) == 1, 'Expected exactly one visible selected command:\n' + '\n'.join(rows)
    return selected[0]


def browser_selection(app):
    deadline = time.monotonic() + 2
    while True:
        rows = app.snapshot()['lines'][3:app.rows - 3]
        selected = [' '.join(line[line.index('› ') + 2:].split()) for line in rows if '› ' in line]
        if len(selected) == 1:
            return selected[0]
        if time.monotonic() >= deadline:
            raise AssertionError('Expected exactly one selected browser entry:\n' + '\n'.join(rows))
        app.drain(0.05)


def filter_browser(app, query):
    app.send('f')
    app.send(CTRL_U)
    app.send(query)
    app.send(ENTER)
    app.expect(query)


def assert_readable_text(test, snapshot, label, row=None):
    """Check VT cells, not raw escape sequences that may belong to an older frame."""
    matches = []
    for y, cells in enumerate(snapshot['attributes']):
        if row is not None and y != row:
            continue
        text = ''.join(cell['chars'] for cell in cells)
        start = text.find(label)
        if start < 0:
            continue
        offset = 0
        matched = []
        for cell in cells:
            end = offset + len(cell['chars'])
            if offset < start + len(label) and end > start and cell['chars'].strip():
                matched.append(cell)
            offset = end
        matches.append(matched)
    test.assertEqual(len(matches), 1, f'Expected one visible {label!r}:\n' + '\n'.join(snapshot['lines']))
    test.assertTrue(matches[0], f'No printable cells found for {label!r}')
    for cell in matches[0]:
        test.assertFalse(cell['dim'], f'{label!r} contains a dim cell: {cell}')
        test.assertTrue(cell['foregroundDefault'], f'{label!r} must use the terminal foreground: {cell}')


class TerminalAcceptance(unittest.TestCase):
    def setUp(self):
        self.fixture = tempfile.TemporaryDirectory(prefix='shell-mindmap-pty-')
        self.home = Path(self.fixture.name)

    def tearDown(self):
        self.fixture.cleanup()

    def fresh(self, file):
        terminal = Terminal(self.home, file)
        terminal.expect('编辑节点')
        return terminal

    def test_browser_parent_entry_navigation_above_startup_and_root_boundary(self):
        upper = self.home / 'UpperFolder'
        parent = upper / 'LaunchFolder'
        workspace = parent / 'DeepFolder'
        workspace.mkdir(parents=True)
        for directory, name in ((upper, 'upper.mm'), (parent, 'parent.mm'), (workspace, 'deep.mm')):
            (directory / name).write_text('MM-ZSH-1\n0\t0\t' + name + '\n', encoding='utf-8')
        with Terminal(self.home, cwd=workspace, columns=120) as app:
            app.expect('deep.mm'); app.expect('.. 上级目录')
            app.send('\t'); app.send(HOME)
            self.assertIn('.. 上级目录', browser_selection(app))
            app.send(' ')
            app.expect('deep.mm')  # The parent entry is a destination, not an expandable branch.
            app.send(ENTER); app.expect('parent.mm'); app.absent('deep.mm')
            app.send('\t'); app.send(HOME); app.send(RIGHT)
            app.expect('upper.mm'); app.absent('parent.mm')
            # The anchor itself can leave the original subtree with Left, even while expanded.
            app.resize(48, 12); app.send('\t')
            self.assertIn('UpperFolder', browser_selection(app))
            app.send(LEFT); app.expect('.. 上级目录')
            self.assertTrue(app.snapshot()['lines'][1].strip().endswith(self.home.name))
            app.resize(120, 24)
            app.send('o'); app.send(str(parent)); app.send(ENTER); app.expect('parent.mm')
            app.send('\t'); app.send(RIGHT)
            self.assertIn('DeepFolder', browser_selection(app))
            app.send(BACKSPACE); app.expect('upper.mm'); app.absent('parent.mm')
            # Backspace follows the active directory, not the selected descendant.
            self.assertTrue(app.snapshot()['lines'][1].strip().endswith('UpperFolder'))
            app.send('o'); app.send(str(Path('/'))); app.send(ENTER)
            app.expect('文件浏览')
            self.assertEqual(app.snapshot()['lines'][1].strip(), '/')
            app.absent('.. 上级目录')
            app.send(LEFT)  # Also focuses the tree when the machine root happens to contain maps.
            app.send(HOME); app.send(LEFT)
            app.expect('已到文件系统根目录，没有上级目录。')
            app.send(BACKSPACE); app.expect('已到文件系统根目录，没有上级目录。')
            self.assertEqual(app.snapshot()['lines'][1].strip(), '/')
            self.assertIsNone(app.process.poll())
            app.send('q'); app.exited_cleanly()

    def test_browser_parent_navigation_preserves_dirty_document_until_open_or_new(self):
        workspace = self.home / 'ParentWithMap' / 'WorkingChild'
        workspace.mkdir(parents=True)
        original = 'MM-ZSH-1\n0\t0\tCHILDORIGINAL\n'
        first = workspace / 'child.mm'
        first.write_text(original, encoding='utf-8')
        other = workspace.parent / 'parent-map.mm'
        other.write_text('MM-ZSH-1\n0\t0\tPARENTORIGINAL\n', encoding='utf-8')
        with Terminal(self.home, first, cwd=workspace, columns=120) as app:
            app.expect('CHILDORIGINAL'); app.send('e'); app.replace('CHILDDIRTY')
            app.send('O'); app.expect('文件浏览'); app.send('\t'); app.send(HOME)
            self.assertIn('.. 上级目录', browser_selection(app))
            app.send(ENTER); app.expect('parent-map.mm'); app.absent('有未保存的修改')
            app.send(ENTER); app.expect('有未保存的修改'); app.send(ESC); app.expect('文件浏览')
            app.send('n'); app.expect('有未保存的修改'); app.send(ESC); app.expect('文件浏览')
            app.send(ESC); app.expect('CHILDDIRTY'); app.expect('●')
            self.assertEqual(first.read_text(encoding='utf-8'), original)
            self.assertEqual(records(other)[0][2], 'PARENTORIGINAL')
            app.send('q'); app.expect('有未保存的修改'); app.send('d'); app.exited_cleanly()

    def test_browser_supporting_text_uses_full_terminal_foreground(self):
        workspace = self.home / 'ContrastFolder'
        (workspace / 'Child').mkdir(parents=True)
        (workspace / 'visible.mm').write_text('MM-ZSH-1\n0\t0\tCOLORROOT\n', encoding='utf-8')
        with Terminal(self.home, cwd=workspace, columns=120) as app:
            app.expect('visible.mm')
            snapshot = app.snapshot(attributes=True)
            assert_readable_text(self, snapshot, 'ContrastFolder', row=1)
            assert_readable_text(self, snapshot, '目录树 · [当前] 位置')
            assert_readable_text(self, snapshot, 'Tab 切区')
            assert_readable_text(self, snapshot, '↑↓ 选择')
            assert_readable_text(self, snapshot, 'Backspace 上级')
            counter_row = next(i for i, line in enumerate(snapshot['lines']) if '目录 1–' in line)
            counter = snapshot['lines'][counter_row]
            assert_readable_text(self, snapshot, counter.split('│')[0].strip(), row=counter_row)
            assert_readable_text(self, snapshot, counter.split('│')[1].strip(), row=counter_row)
            app.send('\t')
            assert_readable_text(self, app.snapshot(attributes=True), '脑图 · 1   最近修改 ↓')
            app.resize(48, 12)
            snapshot = app.snapshot(attributes=True)
            assert_readable_text(self, snapshot, 'ContrastFolder', row=1)
            assert_readable_text(self, snapshot, 'Tab 切区')
            counter_row = next(i for i, line in enumerate(snapshot['lines']) if '目录 1–' in line)
            assert_readable_text(self, snapshot, snapshot['lines'][counter_row].strip(), row=counter_row)
            app.send('\t')
            snapshot = app.snapshot(attributes=True)
            counter_row = next(i for i, line in enumerate(snapshot['lines']) if '脑图 1–' in line)
            assert_readable_text(self, snapshot, snapshot['lines'][counter_row].strip(), row=counter_row)
            app.send('q'); app.exited_cleanly()

    def test_all_panel_supporting_text_uses_full_terminal_foreground(self):
        file = self.home / 'PanelContrast.mm'
        original = 'MM-ZSH-1\n0\t0\tROOTCONTRAST\n1\t0\tBRANCHCONTRAST\n1\t0\tOTHERCONTRAST\n'
        file.write_text(original, encoding='utf-8')

        def assert_panel(app, *labels):
            snapshot = app.snapshot(attributes=True)
            assert_readable_text(self, snapshot, '向右布局 · 3 节点', row=1)
            assert_readable_text(self, snapshot, 'PanelContrast.mm', row=1)
            for label in labels:
                assert_readable_text(self, snapshot, label)

        with Terminal(self.home, file, columns=120) as app:
            app.expect('ROOTCONTRAST')
            assert_panel(app, 'Tab 子节点', 'Enter 同级', 'e 编辑', '? 帮助', '/ 命令',
                         's 保存', 'f 搜索', 'O 文件浏览', 'q 退出')
            panels = [
                ('?', '快捷键（浏览模式）', ('帮助 · ↑↓ 滚动 / PgUp PgDn 翻页', '? / F1 / Esc 返回 · Enter 保留帮助')),
                (',', '设置 · ↑↓ 选择 / Enter 修改', ('设置 · ↑↓ 选择 / Enter 修改', '设置立即生效 · : 打开命令 · Esc 返回')),
            ]
            for key, heading, labels in panels:
                with self.subTest(panel=heading):
                    app.send(key); app.expect(heading)
                    assert_panel(app, *labels)
                    app.send(ESC); app.expect('ROOTCONTRAST')
            app.send(RIGHT); app.send('m'); app.expect('移动分支')
            assert_panel(app, '移动分支 · 选择新的父节点', '↑↓ 选择 · Enter 确认 · Esc 返回', 'OTHERCONTRAST')
            app.send(ESC); app.expect('ROOTCONTRAST')

            # Supply valid independent sessions after startup, so this exercises the
            # recovery panel without a crash or an extra process just to create fixtures.
            recovery_dir = self.home / 'Shell Mindmap' / '.app' / 'recovery'
            recovery_dir.mkdir(parents=True, exist_ok=True)
            for index in range(2):
                session = f'contrast-session-{index}'
                snapshot = {'sessionId': session, 'updatedAt': f'2026-10-0{index + 1}T00:00:00.000Z',
                            'nodes': [{'id': 'root', 'text': f'RECOVERYCONTRAST{index}', 'depth': 0, 'folded': False}]}
                (recovery_dir / f'{session}.json').write_text(json.dumps(snapshot), encoding='utf-8')
            app.command('recover'); app.expect('恢复未保存的脑图')
            assert_panel(app, '恢复未保存的脑图', '↑↓ 选择 · Enter 确认 · Esc 返回', 'RECOVERYCONTRAST0')
            app.send(ESC); app.expect('ROOTCONTRAST')
            app.send('e'); app.replace('DIRTYCONTRAST')
            app.send('q'); app.expect('有未保存的修改')
            assert_panel(app, 's 保存后继续 · d 放弃修改 · Esc 返回')
            app.send(ESC); app.expect('DIRTYCONTRAST')
            app.resize(48, 12)
            snapshot = app.snapshot(attributes=True)
            assert_readable_text(self, snapshot, '向右布局 · 3 节点', row=1)
            assert_readable_text(self, snapshot, 'Tab 子节点')
            assert_readable_text(self, snapshot, 'Enter 同级')
            app.send('q'); app.expect('有未保存的修改'); app.send('d'); app.exited_cleanly()
        self.assertEqual(file.read_text(encoding='utf-8'), original)

    def test_all_input_hints_placeholders_and_counters_use_full_terminal_foreground(self):
        workspace = self.home / 'InputContrast'
        workspace.mkdir()
        file = workspace / 'inputs.mm'
        original = 'MM-ZSH-1\n0\t0\tINPUTROOT\n1\t0\tINPUTCHILD\n'
        file.write_text(original, encoding='utf-8')

        def assert_input(app, placeholder, hint, node=False):
            snapshot = app.snapshot(attributes=True)
            assert_readable_text(self, snapshot, placeholder, row=app.rows - 4)
            assert_readable_text(self, snapshot, hint, row=app.rows - 2)
            if node:
                assert_readable_text(self, snapshot, '0/300', row=app.rows - 6)

        with Terminal(self.home, file, columns=120, cwd=workspace) as app:
            app.expect('INPUTROOT'); app.send(RIGHT)
            standard_hint = 'Enter 确认 · Esc 取消 · Ctrl-U 清空'
            dialogs = [
                ('e', '编辑节点', '输入节点文字，或 / 查看命令', standard_hint, True),
                ('\t', '添加子节点', '输入子节点文字，或 / 查看命令', standard_hint, True),
                (ENTER, '添加同级节点', '输入同级节点文字，或 / 查看命令', standard_hint, True),
                ('f', '搜索全部节点', '输入关键词，搜索全部节点…', '↑↓ 选结果 · Enter 定位 · Esc 取消', False),
                ('/', '命令菜单', '输入命令或中文描述，例如 保存', '↑↓ 选择 · Tab 补全 · Enter 确认 · Esc 返回', False),
                ('S', '保存到文件', '输入保存路径，例如 项目计划.mm', standard_hint, False),
                ('I', '导入 Markdown', '输入 Markdown 路径，例如 大纲.md', standard_hint, False),
                ('E', '导出 Markdown', '输入导出路径，例如 大纲.md', standard_hint, False),
            ]
            for key, title, placeholder, hint, node in dialogs:
                with self.subTest(input=title):
                    app.send(key); app.expect(title); app.send(CTRL_U)
                    assert_input(app, placeholder, hint, node)
                    if title == '编辑节点':
                        app.send('中文👩‍💻')
                        snapshot = app.snapshot(attributes=True)
                        assert_readable_text(self, snapshot, '5/300', row=app.rows - 6)
                        assert_readable_text(self, snapshot, '中文👩‍💻', row=app.rows - 4)
                    if title == '搜索全部节点':
                        assert_readable_text(self, app.snapshot(attributes=True), '个结果 · ↑↓ 选择 / Enter 定位')
                    if title == '命令菜单':
                        app.send('zzzznomatch'); app.expect('没有匹配的命令')
                        assert_readable_text(self, app.snapshot(attributes=True), '没有匹配的命令 · 修改关键词或 Esc 返回')
                        app.send(CTRL_U); app.send('open /tmp/example'); app.expect('参数输入中')
                        assert_readable_text(self, app.snapshot(attributes=True), '参数输入中 · Enter 执行，路径含空格请加引号')
                    app.send(ESC); app.expect('INPUTROOT')
            app.send('O'); app.expect('文件浏览')
            for key, title, placeholder, hint in [
                ('o', '打开文件或目录', '输入文件或目录路径，例如 项目计划.mm', standard_hint),
                ('f', '筛选文件和目录', '筛选已加载的目录和当前目录的脑图…', '↑↓ 选择 · Tab 切区 · Enter 保留筛选 · Esc 清除'),
            ]:
                with self.subTest(input=title):
                    app.send(key); app.expect(title); app.send(CTRL_U)
                    assert_input(app, placeholder, hint)
                    app.send(ESC); app.expect('文件浏览')
            app.send(ESC); app.expect('INPUTROOT')
            app.resize(48, 12); app.send('e'); app.send(CTRL_U)
            assert_input(app, '输入节点文字，或 / 查看命令', standard_hint, True)
            app.send(ESC); app.send('q'); app.exited_cleanly()
        self.assertEqual(file.read_text(encoding='utf-8'), original)
        self.assertEqual(list(workspace.glob('*.mm')), [file])
        self.assertEqual(list(workspace.glob('*.md')), [])

    def test_browser_hundred_folders_tree_depth_scrolling_and_independent_maps(self):
        workspace = self.home / 'TreeWorkspace'
        workspace.mkdir()
        for index in range(100):
            (workspace / f'Folder{index:02d}').mkdir()
        child = workspace / 'Folder29'
        nested = child / 'Nested'
        nested.mkdir()
        (workspace / 'Folder98' / 'UnloadedNeedle').mkdir()
        saved = child / 'old-map.mm'
        saved.write_text('MM-ZSH-1\n0\t0\tBROWSEROLDMAP\n', encoding='utf-8')
        deep_saved = nested / 'deep.mm'
        deep_saved.write_text('MM-ZSH-1\n0\t0\tDEEPROOT\n', encoding='utf-8')
        for name, modified in [('older.mm', 1), ('recent.mm', 2)]:
            file = workspace / name
            file.write_text('MM-ZSH-1\n0\t0\t' + name + '\n', encoding='utf-8')
            os.utime(file, (modified, modified))
        with Terminal(self.home, cwd=workspace, columns=100, rows=24) as app:
            app.expect('文件浏览'); app.expect('目录树'); app.expect('脑图')
            self.assertIn('recent.mm', browser_selection(app))
            app.send('\t')
            self.assertIn('TreeWorkspace', browser_selection(app))
            app.send(PAGE_DOWN)
            after_page = browser_selection(app)
            self.assertIn('Folder', after_page)
            app.send(PAGE_DOWN)
            self.assertNotEqual(browser_selection(app), after_page)
            app.expect('recent.mm'); app.expect('older.mm')
            app.send(END)
            self.assertIn('Folder99', browser_selection(app))
            app.expect('recent.mm')  # Scrolling 100 folders cannot displace the maps pane.
            app.send('\t'); app.send(END)
            self.assertIn('older.mm', browser_selection(app))
            app.send(UP)
            self.assertIn('recent.mm', browser_selection(app))
            app.send(HOME)
            self.assertIn('recent.mm', browser_selection(app))
            filter_browser(app, 'Folder29')
            app.absent('Folder00')
            self.assertIn('Folder29', browser_selection(app))
            app.send(ENTER)
            app.expect('old-map.mm'); app.expect('Nested'); app.expect('[当前]')
            tree_lines = app.snapshot()['lines'][4:app.rows - 4]
            folder_line = next(line for line in tree_lines if 'Folder29' in line and '├─' in line)
            child_line = next(line for line in tree_lines if 'Nested' in line and '└─' in line)
            self.assertGreater(child_line.index('Nested'), folder_line.index('Folder29'))
            # Ancestors and second-level children remain in one tree after navigation.
            app.send('\t')
            self.assertIn('Folder29', browser_selection(app))
            app.send(RIGHT)
            self.assertIn('Nested', browser_selection(app))
            app.send(ENTER); app.expect('deep.mm')
            app.send('\t'); app.send(HOME); app.send(DOWN)
            self.assertIn('TreeWorkspace', browser_selection(app))
            app.send(' ')
            app.absent('Folder00')
            app.expect('Nested'); app.expect('deep.mm')
            # Expanding or selecting a directory does not silently change the active folder.
            app.send(RIGHT); app.expect('Folder00'); app.expect('deep.mm')
            app.send(RIGHT)
            self.assertIn('Folder00', browser_selection(app))
            app.expect('deep.mm')
            app.send(LEFT)
            self.assertIn('TreeWorkspace', browser_selection(app))
            app.send(BACKSPACE); app.expect('old-map.mm')
            # Only opened levels are filtered; the filesystem is not scanned recursively.
            filter_browser(app, 'UnloadedNeedle')
            self.assertFalse(any('› ' in line and 'UnloadedNeedle' in line
                                 for line in app.snapshot()['lines'][3:app.rows - 3]))
            app.send(ESC)
            filter_browser(app, 'old-map'); app.send(ENTER)
            app.expect('BROWSEROLDMAP')
            app.send('O'); app.expect('文件浏览'); app.expect('old-map.mm')
            app.send(ESC); app.expect('BROWSEROLDMAP')
            app.send('q'); app.exited_cleanly()
        self.assertEqual(records(saved)[0][2], 'BROWSEROLDMAP')
        self.assertEqual(records(deep_saved)[0][2], 'DEEPROOT')

    def test_browser_narrow_tabs_and_resize_preserve_each_pane_selection(self):
        workspace = self.home / 'NarrowTree'
        workspace.mkdir()
        for index in range(25):
            (workspace / f'Folder{index:02d}').mkdir()
        for name in ('first.mm', 'second.mm'):
            (workspace / name).write_text('MM-ZSH-1\n0\t0\t' + name + '\n', encoding='utf-8')
        with Terminal(self.home, cwd=workspace, columns=48, rows=12) as app:
            app.expect('文件浏览')
            app.send(END)
            chosen_map = browser_selection(app)
            self.assertIn('.mm', chosen_map)
            app.send('\t'); app.send(END)
            self.assertIn('Folder24', browser_selection(app))
            # Small terminals use tabs. The two selections survive tabbing and resizing.
            app.send('\t')
            self.assertEqual(browser_selection(app), chosen_map)
            for columns, rows in ((100, 24), (48, 12), (80, 24), (48, 12)):
                app.resize(columns, rows); app.expect('文件浏览')
                self.assertEqual(browser_selection(app), chosen_map)
                app.send('\t')
                self.assertIn('Folder24', browser_selection(app))
                app.send('\t')
            app.send(ENTER); app.expect('1 节点')
            app.send('q'); app.exited_cleanly()

    def test_browser_startup_context_and_new_map_in_browsed_directory(self):
        workspace = self.home / '启动 项目'
        child = workspace / '子目录'
        child.mkdir(parents=True)
        global_save = self.home / '全局 保存目录'
        global_save.mkdir()
        with Terminal(self.home, cwd=workspace) as app:
            app.expect('文件浏览')
            app.cli(['config', 'set', 'save-dir', str(global_save)])
            app.send('q'); app.exited_cleanly()
        with Terminal(self.home, cwd=workspace) as app:
            app.expect('文件浏览'); app.expect('子目录')
            app.send(ESC); app.expect('文件浏览')
            app.send('/'); app.expect('命令 ·'); app.send(ESC); app.expect('文件浏览')
            app.send('?'); app.expect('快捷键（浏览模式）'); app.send(ESC); app.expect('文件浏览')
            filter_browser(app, '子目录'); app.send(ENTER)
            app.send('n'); app.expect('编辑节点'); app.send('目录中的新脑图'); app.send(ENTER)
            app.send('s'); app.expect('保存到文件'); app.send(ENTER); app.expect('已保存')
            expected = child / '目录中的新脑图.mm'
            self.assertEqual(records(expected)[0][2], '目录中的新脑图')
            self.assertFalse((workspace / expected.name).exists())
            self.assertFalse((global_save / expected.name).exists())
            app.send('O'); app.expect('文件浏览'); app.expect(expected.name)
            app.send(ESC); app.expect('目录中的新脑图')
            app.send('q'); app.exited_cleanly()
        with Terminal(self.home, cwd=child) as app:
            app.expect('文件浏览'); app.expect('目录中的新脑图.mm')
            filter_browser(app, '目录中的新脑图'); app.send(ENTER)
            app.expect('1 节点'); app.expect('目录中的新脑图')
            app.send('q'); app.exited_cleanly()

    def test_browser_hidden_refresh_paths_and_corrupt_file_are_recoverable(self):
        workspace = self.home / '查找路径'
        workspace.mkdir()
        (workspace / '.Hidden').mkdir()
        (workspace / 'visible').mkdir()
        hidden = workspace / '.secret.mm'
        hidden.write_text('MM-ZSH-1\n0\t0\tHIDDENMAP\n', encoding='utf-8')
        corrupt = workspace / 'broken.mm'
        corrupt.write_text('not a mindmap\n', encoding='utf-8')
        with Terminal(self.home, cwd=workspace) as app:
            app.expect('文件浏览'); app.expect('visible')
            app.absent('.Hidden'); app.absent('.secret.mm')
            app.send('.'); app.expect('.Hidden'); app.expect('.secret.mm')
            app.send('.'); app.absent('.Hidden'); app.absent('.secret.mm')
            late = workspace / 'created-later.mm'
            late.write_text('MM-ZSH-1\n0\t0\tLATERMAP\n', encoding='utf-8')
            app.absent(late.name)
            app.send(CTRL_R); app.expect(late.name)
            app.send('o'); app.send(str(workspace / 'does-not-exist')); app.send(ENTER)
            self.assertIsNone(app.process.poll())
            self.assertFalse((workspace / 'does-not-exist').exists())
            app.send(ESC); app.expect('文件浏览')
            filter_browser(app, 'broken'); app.send(ENTER)
            app.expect('文件浏览'); app.expect('MM-ZSH-1')
            self.assertEqual(corrupt.read_text(), 'not a mindmap\n')
            app.send(ESC); app.expect('文件浏览')
            app.send('o'); app.send(str(workspace / '.Hidden')); app.send(ENTER)
            app.expect('文件浏览')
            app.send(BACKSPACE); app.expect('文件浏览')
            # A hidden folder navigated to explicitly need not be revealed in the parent.
            app.send('.'); app.expect('.Hidden')
            app.send('o'); app.send('visible'); app.send(ENTER); app.expect('文件浏览')
            app.send('o'); app.send('../created-later.mm'); app.send(ENTER)
            app.expect('LATERMAP'); app.send('q'); app.exited_cleanly()

    def test_browser_dirty_open_and_new_confirmation_preserve_cancelled_document(self):
        workspace = self.home / '修改保护'
        workspace.mkdir()
        first, second = workspace / 'first.mm', workspace / 'second.mm'
        original = 'MM-ZSH-1\n0\t0\tFIRSTROOT\n'
        first.write_text(original, encoding='utf-8')
        second.write_text('MM-ZSH-1\n0\t0\tSECONDROOT\n', encoding='utf-8')
        with Terminal(self.home, first, cwd=workspace) as app:
            app.expect('FIRSTROOT'); app.send('e'); app.replace('DIRTYROOT')
            app.send('O'); app.expect('文件浏览')
            app.absent('有未保存的修改')
            filter_browser(app, 'second'); app.send(ENTER)
            app.expect('有未保存的修改'); app.send(ESC); app.expect('文件浏览')
            app.send(ESC)  # Clear the retained browser filter first, when present.
            if '文件浏览' in app.screen():
                app.send(ESC)
            app.expect('DIRTYROOT')
            app.send('O'); app.expect('文件浏览'); app.send('n')
            app.expect('有未保存的修改'); app.send(ESC); app.expect('文件浏览')
            app.send('n'); app.expect('有未保存的修改'); app.send('s')
            app.expect('编辑节点')
            self.assertEqual(records(first)[0][2], 'DIRTYROOT')
            app.send('AFTERNEW'); app.send(ENTER)
            app.send('O'); app.expect('文件浏览'); app.send('n')
            app.expect('有未保存的修改'); app.send('s'); app.expect('保存到文件')
            app.send(ESC); app.expect('文件浏览')
            self.assertFalse((workspace / 'AFTERNEW.mm').exists())
            app.send(ESC); app.expect('AFTERNEW'); app.expect('●')
            app.send('s'); app.expect('保存到文件'); app.send(ENTER); app.expect('已保存')
            self.assertEqual(records(workspace / 'AFTERNEW.mm')[0][2], 'AFTERNEW')
            self.assertEqual(records(second)[0][2], 'SECONDROOT')
            app.send('q'); app.exited_cleanly()

    def test_browser_new_map_recovery_retains_chosen_directory(self):
        workspace = self.home / '恢复启动目录'
        child = workspace / '保存 子目录'
        child.mkdir(parents=True)
        recovery = self.home / 'Shell Mindmap' / '.app' / 'recovery'
        with Terminal(self.home, cwd=workspace) as app:
            app.expect('文件浏览')
            filter_browser(app, '保存 子目录'); app.send(ENTER)
            app.send('n'); app.expect('编辑节点')
            app.send('目录恢复内容'); app.send(ENTER)
            app.send('\t'); app.send('未保存分支'); app.send(ENTER)
            app.expect('2 节点')
            deadline = time.monotonic() + 4
            durable = None
            while time.monotonic() < deadline:
                snapshots = list(recovery.glob('*.json'))
                if snapshots:
                    candidate = json.loads(snapshots[0].read_text())
                    if [node['text'] for node in candidate['nodes']] == ['目录恢复内容', '未保存分支']:
                        durable = candidate
                        break
                app.drain(0.1)
            self.assertIsNotNone(durable, 'The browser-created document was not snapshotted')
            self.assertEqual(Path(durable['saveDirectory']).resolve(), child.resolve())
            self.assertEqual(list(child.glob('*.mm')), [])
            app.process.kill(); app.process.wait(timeout=3)
        with Terminal(self.home, cwd=self.home / '其他启动目录') as app:
            app.expect('文件浏览'); app.send('r'); app.expect('恢复未保存的脑图')
            app.send(ENTER); app.expect('已恢复未保存内容'); app.expect('2 节点')
            app.send('s'); app.expect('保存到文件'); app.send(ENTER); app.expect('已保存')
            self.assertEqual([node[2] for node in records(child / '目录恢复内容.mm')],
                             ['目录恢复内容', '未保存分支'])
            self.assertFalse((app.cwd / '目录恢复内容.mm').exists())
            app.send('q'); app.exited_cleanly()
        self.assertEqual(list(recovery.glob('*.json')), [])

    def test_cwd_defaults_follow_each_launch_without_moving_old_maps(self):
        first = self.home / '项目甲'
        second = self.home / '项目乙'
        old_library = self.home / 'Shell Mindmap'
        old_library.mkdir()
        historical = old_library / '历史脑图.mm'
        historical_content = 'MM-ZSH-1\n0\t0\t历史内容\n'
        historical.write_text(historical_content, encoding='utf-8')
        first_file, second_file = first / '甲图.mm', second / '乙图.mm'
        with Terminal(self.home, cwd=first) as app:
            app.expect('文件浏览'); app.send('n'); app.expect('编辑节点'); app.send('甲图'); app.send(ENTER)
            app.command('set node-width 40'); app.expect('设置已保存并立即生效')
            app.send('s'); app.expect('保存到文件'); app.expect('甲图.mm')
            app.send(ENTER); app.expect('已保存')
            self.assertEqual(records(first_file)[0][2], '甲图')
            app.send('E'); app.expect('导出 Markdown'); app.expect('甲图.md')
            app.send(ENTER); app.expect('已导出')
            self.assertIn('# 甲图', (first / '甲图.md').read_text())
            app.send('O'); app.expect('文件浏览'); app.expect('甲图.mm'); app.absent('历史脑图.mm')
            self.assertEqual([Path(line).resolve() for line in app.cli(['list']).splitlines()], [first_file.resolve()])
            app.send(ESC); app.send('q'); app.exited_cleanly()
        config = json.loads((old_library / '.app' / 'config.json').read_text())
        self.assertEqual((config['version'], config['saveDir'], config['nodeWidth']), (2, '', 40))
        with Terminal(self.home, cwd=second) as app:
            app.expect('文件浏览'); app.send('n'); app.expect('编辑节点'); app.send('乙图'); app.send(ENTER)
            app.send(','); app.expect('node-width = 40'); app.send(ESC)
            app.send('s'); app.expect('保存到文件'); app.expect('乙图.mm')
            app.send(ENTER); app.expect('已保存')
            self.assertEqual(records(second_file)[0][2], '乙图')
            self.assertFalse((first / '乙图.mm').exists())
            app.send('E'); app.expect('导出 Markdown'); app.expect('乙图.md')
            app.send(ENTER); app.expect('已导出')
            self.assertIn('# 乙图', (second / '乙图.md').read_text())
            self.assertFalse((first / '乙图.md').exists())
            app.send('O'); app.expect('文件浏览'); app.expect('乙图.mm')
            app.absent('甲图.mm'); app.absent('历史脑图.mm')
            self.assertEqual([Path(line).resolve() for line in app.cli(['list']).splitlines()], [second_file.resolve()])
            app.send(ESC)
            app.command('open ' + json.dumps(str(first_file), ensure_ascii=False)); app.expect('甲图.mm')
            app.send('e'); app.replace('甲图已更新'); app.send('s'); app.expect('已保存')
            self.assertEqual(records(first_file)[0][2], '甲图已更新')
            self.assertEqual(records(second_file)[0][2], '乙图')
            self.assertFalse((second / '甲图已更新.mm').exists())
            app.send('q'); app.exited_cleanly()
        self.assertEqual(historical.read_text(), historical_content)
        self.assertEqual(list(old_library.glob('*.mm')), [historical])

    def test_chinese_creation_branch_operations_save_reopen_and_discard(self):
        file = self.home / '中文 项目.mm'
        title = '中文计划👩‍💻e\u0301'
        with self.fresh(file) as app:
            for chunk in ('中文', '计划', '👩‍💻', 'e\u0301'):
                app.send(chunk, settle=0.005)
            app.send(ENTER)
            app.expect('1 节点')
            app.send('\t'); app.send('研究中文'); app.send(ENTER)
            app.send('\t'); app.send('资料👩‍💻'); app.send(ENTER)
            app.send(LEFT); app.send(ENTER); app.send('设计支线'); app.send(ENTER)
            app.send('g'); app.send('\t'); app.send('第三分支'); app.send(ENTER)
            app.expect('5 节点')
            app.send('g'); app.send(RIGHT); app.send('c'); app.send('g'); app.send('p')
            app.expect('7 节点')
            app.send('u'); app.expect('5 节点')
            app.send('r'); app.expect('7 节点')
            app.send('d'); app.expect('5 节点')
            app.send(' '); app.expect('[+]'); app.absent('研究中文')
            app.send(' '); app.expect('研究中文')
            app.send('f'); app.send('第三分支'); app.send(ENTER)
            app.send('m'); app.expect('移动分支'); app.send(DOWN); app.send(ENTER)
            app.send('s'); app.expect('已保存')
            saved = records(file)
            self.assertEqual(saved[0][2], title)
            self.assertEqual(len(saved), 5)
            self.assertEqual(next(item[0] for item in saved if item[2] == '第三分支'), 2)
            app.send(CTRL_C); app.exited_cleanly()
        with Terminal(self.home, file) as app:
            app.expect('5 节点')
            app.send(CTRL_F); app.send('资料'); app.send(ENTER)
            app.expect('已定位')
            app.send('\t'); app.send('不保存的内容'); app.send(ENTER)
            app.send(CTRL_C); app.expect('有未保存的修改')
            app.send(ESC); app.expect('6 节点')
            app.send('q'); app.expect('有未保存的修改'); app.send('d'); app.exited_cleanly()
        self.assertEqual(records(file), saved)

    def test_help_entry_enter_preserves_help_edit_buffer_and_paste_safety(self):
        file = self.home / 'help.mm'
        with self.fresh(file) as app:
            app.send('帮助测试'); app.send(ENTER)
            for opener in ('?', '？', F1):
                app.send(opener); app.expect('快捷键（浏览模式）')
                app.send(ENTER); app.expect('快捷键（浏览模式）')
                self.assertIsNone(app.process.poll())
                app.send(ESC); app.expect('1 节点')
            app.send('e'); app.send(CTRL_U); app.send('编辑未完成👨‍👩‍👧‍👦')
            snap = app.snapshot()
            self.assertEqual((snap['cursorX'], snap['cursorY']), (17, 20))
            app.send(F1); app.expect('快捷键（浏览模式）')
            app.send(ENTER); app.expect('快捷键（浏览模式）')
            app.send(ESC); app.expect('编辑节点'); app.expect('编辑未完成')
            app.send('追加' + F1)
            app.expect('快捷键（浏览模式）')
            app.send(ESC); app.expect('编辑节点'); app.expect('追加')
            app.paste(' q ? d :quit\n中\t文 ' + F1)
            app.expect('编辑节点'); app.absent('快捷键（浏览模式）')
            app.send(ENTER)
            app.paste('qd? :quit\n' + F1)
            app.expect('浏览模式不会执行粘贴中的快捷键')
            app.absent('快捷键（浏览模式）')
            app.send('s'); app.expect('已保存')
            self.assertEqual(records(file)[0][2], '编辑未完成👨‍👩‍👧‍👦追加 q ? d :quit 中 文 ')
            app.send('q'); app.exited_cleanly()

    def test_input_box_placeholder_scroll_and_minimum_window_cursor(self):
        file = self.home / 'input-ui.mm'

        def assert_box(app, cursor_x, count, error=None):
            snap = app.snapshot()
            columns, rows = app.columns, app.rows
            self.assertEqual(snap['lines'][rows - 5], ' ╭' + '─' * (columns - 4) + '╮')
            self.assertEqual(snap['lines'][rows - 3], ' ╰' + '─' * (columns - 4) + '╯')
            self.assertTrue(snap['lines'][rows - 4].startswith(' │ › '), snap['lines'][rows - 4])
            self.assertTrue(snap['lines'][rows - 4].endswith('│'), snap['lines'][rows - 4])
            self.assertEqual(snap['lines'][rows - 4].count('│'), 2)
            self.assertIn('编辑节点', snap['lines'][rows - 6])
            self.assertTrue(snap['lines'][rows - 6].rstrip().endswith(f'{count}/300'))
            self.assertIn(error or 'Enter 确认', snap['lines'][rows - 2])
            self.assertEqual(snap['lines'][rows - 1], '')
            self.assertEqual((snap['cursorX'], snap['cursorY']), (cursor_x, rows - 4))
            return snap

        def capture(snap):
            if os.environ.get('MM_TEST_INPUT_SNAPSHOTS'):
                print(f'\nInput screen {snap["columns"]}x{snap["rows"]}:\n' + '\n'.join(snap['lines'])
                      + f'\nCursor: ({snap["cursorX"]}, {snap["cursorY"]})', flush=True)

        with self.fresh(file) as app:
            empty = assert_box(app, 5, 0)
            self.assertIn('输入节点文字，或 / 查看命令', empty['lines'][20])
            app.send(ENTER)
            invalid = assert_box(app, 5, 0, error='节点文字不能为空')
            self.assertIn('节点文字不能为空', invalid['lines'][22])
            self.assertIn('输入节点文字，或 / 查看命令', invalid['lines'][20])
            app.send('中文计划')
            short = assert_box(app, 13, 4)
            self.assertIn('中文计划', short['lines'][20])
            self.assertNotIn('输入节点文字，或 / 查看命令', short['lines'][20])
            capture(short)
            long_text = '起点' + '中文' * 30 + '终点'
            app.send(CTRL_U); app.send(long_text)
            end = assert_box(app, 76, 64)
            self.assertIn('终点', end['lines'][20])
            self.assertNotIn('起点', end['lines'][20])
            app.send(ESC + '[H')
            start = assert_box(app, 5, 64)
            self.assertIn('起点', start['lines'][20])
            self.assertNotIn('终点', start['lines'][20])
            app.send(ESC + '[F'); assert_box(app, 76, 64)
            app.resize(48, 12)
            narrow = assert_box(app, 44, 64)
            self.assertIn('终点', narrow['lines'][8])
            self.assertNotIn('起点', narrow['lines'][8])
            capture(narrow)
            app.send(ESC + '[H')
            narrow_start = assert_box(app, 5, 64)
            self.assertIn('起点', narrow_start['lines'][8])
            app.send(ESC + '[F'); assert_box(app, 44, 64)
            app.send(ENTER); app.send('s'); app.expect('已保存')
            self.assertEqual(records(file)[0][2], long_text)
            app.send('q'); app.exited_cleanly()

    def test_command_palette_fuzzy_selection_arguments_and_unknown_command(self):
        file = self.home / 'palette.mm'
        file.write_text('MM-ZSH-1\n0\t0\t命令菜单原稿\n', encoding='utf-8')
        alternate = self.home / '带 空格 的保存.mm'
        with Terminal(self.home, file) as app:
            app.expect('命令菜单原稿'); app.send('e'); app.replace('命令菜单保存内容')
            app.send('/'); app.expect('命令 ·'); app.expect('/write'); app.expect('保存')
            initial = palette_selection(app)
            self.assertIn('/help', initial); self.assertIn('帮助', initial)
            app.send(DOWN)
            self.assertNotEqual(palette_selection(app), initial)
            app.send(UP); self.assertEqual(palette_selection(app), initial)
            app.send('bind'); app.send(ENTER)
            app.expect('参数输入中'); app.expect('请补充参数')
            self.assertIn('│ / bind ', app.snapshot()['lines'][app.rows - 4])
            app.send(CTRL_U); app.send('wrt')
            self.assertIn('/write', palette_selection(app)); self.assertIn('保存', palette_selection(app))
            app.send('\t')
            self.assertIn('│ / write', app.snapshot()['lines'][app.rows - 4])
            app.send(ENTER); app.expect('已保存')
            self.assertEqual(records(file)[0][2], '命令菜单保存内容')
            app.send('/'); app.send('保存'); app.expect('/write'); app.expect('保存')
            self.assertIn('保存', palette_selection(app))
            app.send(ENTER); app.expect('已保存')
            # The typed command and quoted path must execute unchanged, rather
            # than replacing the arguments with a selected fuzzy suggestion.
            app.send('/'); app.send('write ' + json.dumps(str(alternate), ensure_ascii=False))
            app.send(ENTER); app.expect('已保存')
            self.assertEqual(records(alternate), records(file))
            saved = alternate.read_bytes()
            app.send('/'); app.send('zzzz-no-such-command')
            app.expect('没有匹配的命令'); app.send(ENTER)
            app.expect('没有匹配的命令')
            snap = app.snapshot()
            self.assertIn('zzzz-no-such-command', snap['lines'][app.rows - 4])
            self.assertIn('命令', snap['lines'][app.rows - 6])
            self.assertIsNone(app.process.poll())
            self.assertEqual(alternate.read_bytes(), saved)
            self.assertNotIn('●', snap['lines'][0])
            app.send(ESC); app.send('f'); app.expect('搜索全部节点')
            self.assertIn('│ ? ', app.snapshot()['lines'][app.rows - 4])
            app.send('保存内容'); app.send(ENTER); app.expect('已定位')
            app.send('q'); app.exited_cleanly()

    def test_command_palette_resumes_node_edit_and_keeps_slashes_literal(self):
        file = self.home / 'palette-edit.mm'
        with self.fresh(file) as app:
            app.send('/'); app.expect('命令 ·'); app.send(ESC); app.expect('编辑节点')
            self.assertIn('0/300', app.snapshot()['lines'][app.rows - 6])
            self.assertFalse(file.exists())
            app.send('/'); app.expect('命令 ·'); app.send('/' + '中' * 300)
            app.expect('编辑节点'); app.expect('此次输入未插入')
            rejected = app.snapshot()
            self.assertIn('0/300', rejected['lines'][app.rows - 6])
            self.assertIn('输入节点文字，或 / 查看命令', rejected['lines'][app.rows - 4])
            self.assertEqual((rejected['cursorX'], rejected['cursorY']), (5, app.rows - 4))
            app.send('/'); app.expect('命令 ·'); app.send('/')
            app.expect('编辑节点')
            snap = app.snapshot()
            self.assertIn('│ › /', snap['lines'][app.rows - 4])
            self.assertEqual((snap['cursorX'], snap['cursorY']), (6, app.rows - 4))
            app.send('literal'); app.send(ENTER); app.expect('1 节点')
            app.send('\t'); app.expect('添加子节点'); app.send('/'); app.expect('命令 ·')
            app.send(ESC); app.expect('添加子节点')
            self.assertIn('0/300', app.snapshot()['lines'][app.rows - 6])
            app.send(ESC); app.expect('1 节点')
            app.send('\t'); app.send('/'); app.send('set layout bilateral'); app.send(ENTER)
            app.expect('双侧布局'); app.expect('添加子节点')
            self.assertIn('0/300', app.snapshot()['lines'][app.rows - 6])
            app.expect('1 节点')
            app.send('命令后继续'); app.send(ENTER); app.expect('2 节点')
            app.send('e'); app.send(CTRL_U); app.paste('/help')
            app.expect('编辑节点')
            self.assertIn('│ › /help', app.snapshot()['lines'][app.rows - 4])
            app.send(ENTER); app.expect('2 节点')
            # Leading slash paths belong to path inputs, not the command menu.
            app.send('S'); app.expect('保存到文件'); app.send(CTRL_U); app.send('/tmp')
            app.expect('保存到文件')
            self.assertIn('│ › /tmp', app.snapshot()['lines'][app.rows - 4])
            app.send(ESC); app.send('s'); app.expect('已保存')
            self.assertEqual([node[2] for node in records(file)], ['/literal', '/help'])
            app.send('q'); app.exited_cleanly()

    def test_command_palette_small_window_scroll_and_help_restore(self):
        file = self.home / 'palette-small.mm'
        content = 'MM-ZSH-1\n0\t0\tPALETTEROOT\n'
        file.write_text(content, encoding='utf-8')
        with Terminal(self.home, file, columns=48, rows=12) as app:
            app.expect('PALETTEROOT'); app.send('/'); app.expect('命令 ·')
            previous = palette_selection(app)
            for _ in range(8):
                app.send(DOWN)
                selected = palette_selection(app)
                self.assertNotEqual(selected, previous)
                previous = selected
            app.send('pan')
            self.assertIn('/pan-', palette_selection(app))
            for _ in range(3):
                app.send(DOWN)
                self.assertIn('/pan-', palette_selection(app))
            app.send(LEFT)
            selected = palette_selection(app)
            before = app.snapshot()
            self.assertIn('│ / pan', before['lines'][8])
            self.assertEqual((before['cursorX'], before['cursorY']), (7, 8))
            app.send(F1); app.expect('快捷键（浏览模式）')
            app.send(ENTER); app.expect('快捷键（浏览模式）')
            app.send(ESC); app.expect('命令 ·')
            self.assertEqual(palette_selection(app), selected)
            after = app.snapshot()
            self.assertEqual(after['lines'][8], before['lines'][8])
            self.assertEqual((after['cursorX'], after['cursorY']), (7, 8))
            app.send(ESC); app.send('q'); app.exited_cleanly()
        self.assertEqual(file.read_text(encoding='utf-8'), content)

    def test_settings_immediate_layout_bindings_and_binding_conflict(self):
        file = self.home / 'settings.mm'
        with self.fresh(file) as app:
            app.send('设置测试'); app.send(ENTER)
            app.send(','); app.expect('设置 ·'); app.expect('node-width'); app.send(ESC)
            app.command('set layout bilateral'); app.expect('双侧布局')
            app.command('set node-width 8'); app.expect('设置已保存并立即生效')
            app.command('bind edit z'); app.expect('快捷键已更新')
            app.send('z'); app.expect('编辑节点'); app.send(ESC)
            app.command('bind delete z'); app.expect('快捷键冲突'); app.send(ESC)
            config = json.loads((self.home / 'Shell Mindmap' / '.app' / 'config.json').read_text())
            self.assertEqual((config['layout'], config['nodeWidth'], config['keys']['edit'], config['keys']['delete']), ('bilateral', 8, 'z', 'd'))
            app.command('layout right'); app.expect('向右布局')
            app.send('s'); app.expect('已保存'); app.send('q'); app.exited_cleanly()

    def test_import_export_overwrite_and_external_save_conflict(self):
        source = self.home / '导入 原稿.md'
        source.write_text('# 导入项目\n- 计划\n  - 资料\n- 发布\n', encoding='utf-8')
        invalid = self.home / '损坏.md'
        invalid.write_bytes(b'# broken\xff\n')
        original = self.home / 'original.mm'
        original.write_text('MM-ZSH-1\n0\t0\t原始项目\n', encoding='utf-8')
        exported = self.home / '输出 文档.md'
        imported = self.home / 'imported.mm'
        alternate = self.home / '保留修改.mm'
        with Terminal(self.home, original) as app:
            app.expect('原始项目')
            app.command('import ' + json.dumps(str(invalid), ensure_ascii=False))
            self.assertIn('utf-8', app.expect('encoding').lower())
            app.send(ESC); app.expect('原始项目')
            app.command('export ' + json.dumps(str(exported), ensure_ascii=False)); app.expect('已导出')
            self.assertIn('原始项目', exported.read_text())
            exported.write_text('保留现有内容', encoding='utf-8')
            app.command('export ' + json.dumps(str(exported), ensure_ascii=False)); app.expect('导出文件已存在')
            app.send(ESC); self.assertEqual(exported.read_text(), '保留现有内容'); app.send(ESC)
            app.command('import ' + json.dumps(str(source), ensure_ascii=False)); app.expect('4 节点'); app.expect('Markdown 已导入')
            app.command('export ' + json.dumps(str(exported), ensure_ascii=False)); app.expect('导出文件已存在'); app.send('y'); app.expect('已导出')
            self.assertEqual(exported.read_text(), source.read_text())
            app.command('write ' + json.dumps(str(imported), ensure_ascii=False)); app.expect('已保存')
            self.assertEqual(records(imported)[0][2], '导入项目')
            app.send('e'); app.replace('保存后重开')
            app.command('open ' + json.dumps(str(imported), ensure_ascii=False))
            app.expect('有未保存的修改'); app.send('s'); app.expect('保存后重开')
            self.assertEqual(records(imported)[0][2], '保存后重开')
            app.send('s'); app.expect('已保存')
            external = imported.read_text().replace('保存后重开', '外部修改')
            imported.write_text(external, encoding='utf-8')
            app.send('e'); app.replace('用户修改'); app.send('s')
            app.expect('文件已被其他程序修改'); self.assertEqual(imported.read_text(), external)
            app.send('S'); app.expect('保存到文件'); app.replace(str(alternate)); app.expect('已保存')
            self.assertEqual(imported.read_text(), external)
            self.assertEqual(records(alternate)[0][2], '用户修改')
            app.send('q'); app.exited_cleanly()

    def test_resize_minimum_window_and_restoration(self):
        file = self.home / 'resize.mm'
        file.write_text('MM-ZSH-1\n0\t0\t窗口中文👩‍💻e\u0301\n' + ''.join(f'1\t0\t分支{i}中文内容\n' for i in range(12)), encoding='utf-8')
        with Terminal(self.home, file) as app:
            app.expect('13 节点')
            for columns, rows in ((48, 12), (100, 32), (80, 24), (48, 12)):
                app.resize(columns, rows)
                snap = app.snapshot()
                self.assertEqual((snap['columns'], snap['rows'], len(snap['lines'])), (columns, rows, rows))
                self.assertIn('Shell Mindmap', snap['lines'][0])
                app.expect('13 节点')
            app.send('?'); app.expect('快捷键（浏览模式）'); app.send(ENTER); app.expect('帮助')
            app.send(ESC); app.resize(30, 8); app.expect('请放大至 48 列')
            app.resize(80, 24); app.expect('13 节点'); app.send(CTRL_C); app.exited_cleanly()

    def test_small_map_shift_pan_fallback_keys_commands_and_editing_isolation(self):
        file = self.home / 'pan-small.mm'
        content = 'MM-ZSH-1\n0\t0\tPANROOT\n1\t0\tCHILD\n'
        file.write_text(content, encoding='utf-8')
        movements = [
            ('left', SHIFT_LEFT, 'H', (8, 0)),
            ('down', SHIFT_DOWN, 'J', (0, -3)),
            ('up', SHIFT_UP, 'K', (0, 3)),
            ('right', SHIFT_RIGHT, 'L', (-8, 0)),
        ]
        with Terminal(self.home, file) as app:
            app.expect('PANROOT'); app.send('g')
            origin = canvas_position(app, 'PANROOT')
            self.assertIsNotNone(origin)
            self.assertLessEqual(abs(origin[0] + len('PANROOT') / 2 - app.columns / 2), 2)
            for direction, shifted, fallback, delta in movements:
                expected = (origin[0] + delta[0], origin[1] + delta[1])
                for kind, value in [('shift', shifted), ('fallback', fallback), ('command', 'pan-' + direction)]:
                    with self.subTest(direction=direction, input=kind):
                        app.send('g')
                        self.assertEqual(canvas_position(app, 'PANROOT'), origin)
                        if kind == 'command':
                            app.command(value)
                        else:
                            app.send(value)
                        self.assertEqual(canvas_position(app, 'PANROOT'), expected)
                        self.assertNotIn('●', app.snapshot()['lines'][0])
                        self.assertEqual(file.read_text(encoding='utf-8'), content)
            # A whole input chunk and individually typed uppercase letters must
            # stay in the editor instead of invoking the unmodified pan keys.
            app.send('g'); app.send('e'); app.send(CTRL_U)
            edit_origin = canvas_position(app, 'PANROOT', editing=True)
            self.assertIsNotNone(edit_origin)
            for letter in 'HJKL':
                app.send(letter)
                self.assertEqual(canvas_position(app, 'PANROOT', editing=True), edit_origin)
            self.assertIn('HJKL', app.snapshot()['lines'][app.rows - 4])
            app.paste(' HJKL')
            self.assertEqual(canvas_position(app, 'PANROOT', editing=True), edit_origin)
            self.assertIn('HJKL HJKL', app.snapshot()['lines'][app.rows - 4])
            app.send(ESC); app.send('g')
            self.assertEqual(canvas_position(app, 'PANROOT'), origin)
            self.assertNotIn('●', app.snapshot()['lines'][0])
            # A direct clean exit proves navigation never dirtied the document.
            app.send('q'); app.exited_cleanly()
        self.assertEqual(file.read_text(encoding='utf-8'), content)

    def test_large_map_manual_pan_resize_and_root_recovery(self):
        file = self.home / 'pan-large.mm'
        content = 'MM-ZSH-1\n0\t0\tLARGEROOT\n' + ''.join(f'1\t0\tBranch{i:02d}\n' for i in range(60))
        file.write_text(content, encoding='utf-8')
        with Terminal(self.home, file) as app:
            app.expect('61 节点'); app.send('g')
            self.assertIsNotNone(canvas_position(app, 'LARGEROOT'))
            for shifted, columns, rows in ((SHIFT_DOWN, 48, 12), (SHIFT_RIGHT, 100, 32)):
                for _ in range(10):
                    app.send(shifted)
                self.assertIsNone(canvas_position(app, 'LARGEROOT'))
                app.resize(columns, rows)
                self.assertIsNone(canvas_position(app, 'LARGEROOT'))
                app.send('g')
                position = canvas_position(app, 'LARGEROOT')
                self.assertIsNotNone(position)
                self.assertLessEqual(abs(position[0] + len('LARGEROOT') / 2 - columns / 2), 2)
                self.assertLessEqual(abs(position[1] - (3 + (rows - 7) // 2)), 1)
                self.assertNotIn('●', app.snapshot()['lines'][0])
            app.send('q'); app.exited_cleanly()
        self.assertEqual(file.read_text(encoding='utf-8'), content)

    def test_sigterm_flushes_snapshot_and_next_launch_recovers(self):
        file = self.home / 'recovered.mm'
        with self.fresh(file) as app:
            app.send('崩溃恢复中文'); app.send(ENTER)
            app.send('\t'); app.send('尚未保存👩‍💻'); app.send(ENTER)
            app.expect('2 节点')
            app.process.send_signal(signal.SIGTERM)
            app.exited_cleanly()
        self.assertFalse(file.exists())
        directory = self.home / 'Shell Mindmap' / '.app' / 'recovery'
        snapshots = list(directory.glob('*.json'))
        self.assertEqual(len(snapshots), 1)
        self.assertEqual([item['text'] for item in json.loads(snapshots[0].read_text())['nodes']], ['崩溃恢复中文', '尚未保存👩‍💻'])
        with Terminal(self.home) as app:
            app.expect('文件浏览'); app.send('r'); app.expect('恢复未保存的脑图'); app.expect('崩溃恢复中文')
            app.send(ENTER); app.expect('已恢复未保存内容'); app.expect('2 节点')
            # Restore is durable immediately, before the one-second debounce.
            app.process.send_signal(signal.SIGTERM); app.exited_cleanly()
        snapshots = list(directory.glob('*.json'))
        self.assertEqual(len(snapshots), 1)
        self.assertEqual([item['text'] for item in json.loads(snapshots[0].read_text())['nodes']], ['崩溃恢复中文', '尚未保存👩‍💻'])
        with Terminal(self.home) as app:
            app.expect('文件浏览'); app.send('r'); app.expect('恢复未保存的脑图'); app.send(ENTER); app.expect('已恢复未保存内容')
            app.send('s'); app.expect('已保存'); app.send(CTRL_C); app.exited_cleanly()
        self.assertEqual(records(file)[1][2], '尚未保存👩‍💻')
        self.assertEqual(list(directory.glob('*.json')), [])

    def test_unexpected_kill_recovers_the_debounced_snapshot(self):
        file = self.home / 'unexpected-exit.mm'
        directory = self.home / 'Shell Mindmap' / '.app' / 'recovery'
        with self.fresh(file) as app:
            app.send('异常退出恢复'); app.send(ENTER)
            app.send('\t'); app.send('定时快照中文👩‍💻'); app.send(ENTER)
            app.expect('2 节点')
            deadline = time.monotonic() + 4
            durable = False
            while time.monotonic() < deadline:
                for snapshot in directory.glob('*.json'):
                    content = json.loads(snapshot.read_text())
                    durable = [item['text'] for item in content['nodes']] == ['异常退出恢复', '定时快照中文👩‍💻']
                    if durable:
                        break
                if durable:
                    break
                app.drain(0.1)
            self.assertTrue(durable, 'The one-second debounced snapshot was not written')
            self.assertFalse(file.exists(), 'Recovery must not silently save the original file')
            app.process.kill()  # SIGKILL cannot run application shutdown handlers.
            app.process.wait(timeout=3)
            self.assertEqual(app.process.returncode, -signal.SIGKILL)
        self.assertFalse(file.exists())
        with Terminal(self.home, file) as app:
            app.expect('恢复未保存的脑图'); app.expect('异常退出恢复')
            app.send(ENTER); app.expect('已恢复未保存内容'); app.expect('2 节点')
            app.send('s'); app.expect('已保存'); app.send('q'); app.exited_cleanly()
        self.assertEqual([record[2] for record in records(file)], ['异常退出恢复', '定时快照中文👩‍💻'])
        self.assertEqual(list(directory.glob('*.json')), [])


if __name__ == '__main__':
    if not NODE:
        raise SystemExit('Node.js is required for terminal acceptance tests')
    unittest.main(verbosity=2)
