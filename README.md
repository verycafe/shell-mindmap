# Shell Mindmap

在终端里用键盘整理脑图。基于 TypeScript、React 和 Ink，文件保存在本地，运行时无需 AI 或云服务。

- **目录浏览**：从当前工作目录开始，左侧目录树、右侧脑图列表，忽略无关文件，支持筛选与逐层展开。
- **脑图编辑**：多语言文字与 emoji 输入（Unicode）、折叠、搜索、分支移动／复制、撤销与重做。
- **布局与保存**：向右或双侧布局，兼容 `.mm` 文件，支持 Markdown 大纲导入导出、原子保存和崩溃恢复。

## 安装

需要 Git、**Node.js 22.9+**、**npm 11.10.0+**，以及支持 ANSI 和 UTF-8 的终端。可用 `node --version` 和 `npm --version` 检查版本；Node.js 自带的 npm 不一定满足要求。

```sh
git clone https://github.com/verycafe/shell-mindmap.git
cd shell-mindmap
npm ci
npm run build
npm link
```

`npm link` 将全局命令链接到当前项目，保留这个目录；更新代码后重新构建即可。Windows PowerShell 若限制脚本执行，可使用 `npm.cmd` 和 `SMM.cmd`。不使用全局链接时，执行 `node bin/SMM.js`。

## 使用

在任意工作目录执行：

```sh
SMM                           # 浏览当前目录，打开或新建脑图
SMM "我的脑图.mm"              # 直接编辑；文件不存在时新建
SMM import outline.md -o outline.mm
SMM export outline.mm -o outline.md
```

首页按 `Tab` 切换目录树与脑图列表，方向键选择，`Enter` 打开；`Backspace` 返回上级目录，`n` 在当前浏览目录新建。

编辑界面的常用快捷键：

| 按键 | 操作 |
| --- | --- |
| Tab / Enter | 添加子节点／同级节点 |
| `e` / 空格 | 编辑文字／折叠分支 |
| `f` | 搜索节点 |
| `s` / `S` | 保存／另存为 |
| `u` / `r` | 撤销／重做 |
| `O` / `q` | 文件浏览／退出 |
| `/` | 命令菜单，支持英文与中文模糊筛选 |
| `?` / F1 | 完整帮助 |

默认在工作目录保存脑图；从目录浏览器新建时，使用当前浏览目录。配置和恢复快照存放在 `~/Shell Mindmap/.app`，修改保存目录不会移动已打开的文件。旧 `mm` 命令继续可用。

Markdown 使用一个 `# 根标题` 和每层缩进两个空格的无序列表；不支持的内容会报错，命令行转换不会覆盖已有文件。字号缩放由终端控制。

## 开发

```sh
npm run check
npm test
npm run test:pty
```

PTY 测试需要 macOS/Linux 与 Python 3。仓库提供 macOS、Linux、Windows 的 CI 配置；本机验证环境为 macOS，其他系统的真实终端体验仍需验证。依赖安装沿用锁文件，`.npmrc` 要求新解析的版本已发布至少 7 天。
