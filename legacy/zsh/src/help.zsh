# Scrollable in-terminal reference and stdout help. No external commands.
# mm_config and mm_config_file belong to the caller; mm_help_lines is a local
# indexed array declared by _mm_help_screen (or another caller of the builder).
_mm_help_lines() {
  emulate -L zsh
  local mm_help_topic=${1:-keys} mm_help_action mm_help_setting
  local mm_help_save_dir=$PWD mm_help_width=32 mm_help_config_path
  local -A mm_help_primary=(
    child Tab sibling Enter edit e parent Left child-select Right
    up Up down Down fold Space delete d undo u redo r save s save-as S
    quit q help '?' page-up PageUp page-down PageDown
  )
  if [[ ${(t)mm_config} == *association* ]]; then
    for mm_help_action in ${(k)mm_help_primary}; do
      mm_help_setting="key.${mm_help_action}"
      [[ -n ${mm_config[$mm_help_setting]:-} ]] && mm_help_primary[$mm_help_action]=$mm_config[$mm_help_setting]
    done
    mm_help_save_dir=${mm_config[save-dir]:-$PWD}
    mm_help_width=${mm_config[node-width]:-32}
  fi
  mm_help_config_path=${mm_config_file:-${MM_CONFIG_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/mm/config}}
  mm_help_lines=()
  case $mm_help_topic in
    config)
      mm_help_lines=(
        '当前配置'
        "保存目录：${mm_help_save_dir}"
        "节点列宽：${mm_help_width}；本次使用：${mm_wrap_width:-$mm_help_width}"
        '长节点完整折行；汉字通常占 2 列。'
        "配置文件：${mm_help_config_path}"
        ''
        '在脑图中按 : 输入命令'
        ':config              查看配置'
        ':set node-width 40   修改节点列宽'
        ':set save-dir "/路径/脑图"'
        ':bind help H         将帮助主键改为 H'
        ':reset node-width    恢复该配置默认值'
        ':reset               恢复全部配置默认值'
        ':keys                查看当前快捷键'
        ''
        '也可在 shell 中配置'
        'mm config list'
        'mm config get node-width'
        'mm config set node-width 40'
        'mm config set save-dir "/路径/脑图"'
        'mm config reset [KEY]'
        'mm config path'
        'mm keys bind ACTION KEY'
        'mm keys reset [ACTION]'
        ''
        '配置项：save-dir、node-width、key.ACTION。'
        'save-dir 默认当前工作目录；node-width 默认 32。'
        '配置路径优先级：MM_CONFIG_FILE → XDG_CONFIG_HOME/mm/config → ~/.config/mm/config。'
        'F1 帮助与 : 命令入口固定保留，不能解绑。'
      );;
    commands)
      mm_help_lines=(
        '脑图内命令'
        '按 : 打开命令行，输入后按 Enter 执行。'
        '路径含空格时请加引号；Esc / Ctrl-C 取消输入。'
        ''
        ':help                打开本帮助'
        ':config              查看当前配置'
        ':set KEY VALUE       修改配置'
        ':bind ACTION KEY     修改动作主键'
        ':reset [KEY]         恢复全部或单项配置'
        ':keys                查看当前快捷键'
        ':write [PATH]        保存；可指定文件路径'
        ':quit                退出；未保存时询问'
        ''
        'shell 命令'
        'mm                   新建脑图'
        'mm FILE              打开或新建指定文件'
        'mm -- FILE           将后续参数明确当作文件名'
        'mm help / mm --help  显示完整命令说明'
        'mm config [list|get KEY|set KEY VALUE|reset [KEY]|path]'
        'mm keys [list|bind ACTION KEY|reset [ACTION]]'
        ''
        '快捷键动作 ACTION'
        'child、sibling、edit、parent、child-select'
        'up、down、fold、delete、undo、redo'
        'save、save-as、quit、help、page-up、page-down'
        ''
        '键名示例：Tab、Enter、Space、Up、Down、Left、Right、PageUp、PageDown，以及单个字符。'
        '常用别名 a/o/h/l/k/j/Delete/Ctrl-S 保留；自定义主键优先。'
        'F1 帮助与 : 命令入口固定保留，不能解绑。'
      );;
    *)
      mm_help_lines=(
        '创建与编辑'
        "${mm_help_primary[child]}    添加子节点"
        "${mm_help_primary[sibling]}    添加同级节点"
        "${mm_help_primary[edit]}    编辑当前节点"
        "${mm_help_primary[fold]}    折叠 / 展开当前分支"
        "${mm_help_primary[delete]}    删除当前分支（可撤销）"
        "${mm_help_primary[undo]} / ${mm_help_primary[redo]}    撤销 / 重做"
        ''
        '选择与滚动'
        "${mm_help_primary[parent]}    选择父节点"
        "${mm_help_primary[child-select]}    展开并选择第一个子节点"
        "${mm_help_primary[up]} / ${mm_help_primary[down]}    选择上 / 下一个可见节点"
        "${mm_help_primary[page-up]} / ${mm_help_primary[page-down]}    上下滚动画布"
        'Mac 键盘可用 Fn + ↑ / ↓ 发出 PageUp / PageDown。'
        ''
        '保存与退出'
        "${mm_help_primary[save]} / ${mm_help_primary[save-as]}    保存 / 另存为"
        "${mm_help_primary[quit]}    退出；未保存内容会询问"
        "${mm_help_primary[help]}    打开帮助；也可用 ？ / F1"
        ':    打开命令行（固定入口）'
        "保存目录：${mm_help_save_dir}"
        "当前节点列宽：${mm_wrap_width:-$mm_help_width}"
        ''
        '编辑节点时'
        '左右移动光标；Home / End 跳到行首 / 行尾。'
        'Backspace 删除左侧字符；Delete 删除右侧字符。'
        'Ctrl-U 清空；Enter 确认；Esc / Ctrl-C 取消。'
        '长节点自动折行，完整文字会保存；粘贴作为节点文字。'
        ''
        '关于快捷键'
        '上方显示当前主键。常用别名 a/o/h/l/k/j/Delete/Ctrl-S 保留，自定义主键优先。'
        '可用 :bind ACTION KEY 或 mm keys bind ACTION KEY 修改。'
        'F1 帮助与 : 命令入口固定保留，不能解绑。'
        ''
        '本帮助的操作'
        '↑ / ↓ 逐行滚动；PageUp / PageDown 翻页；Home / End 跳到首尾。'
        '← / → 或 Tab 切换快捷键、配置、命令三个主题。'
        '? / ？ / F1 / Esc / q / Ctrl-C 关闭帮助。'
        'Enter 不关闭帮助，输入 ? 后再按回车也会保留此页。'
      );;
  esac
  return 0
}

_mm_help_screen() {
  emulate -L zsh
  setopt multibyte
  local -a mm_help_lines mm_help_render_lines mm_help_tabs=(keys config commands)
  local mm_help_key mm_help_line mm_help_title mm_help_footer
  local -i mm_help_tab=1 mm_help_offset=0 mm_help_rows mm_help_cols
  local -i mm_help_body mm_help_max_offset mm_help_index mm_help_screen_row
  case ${1:-keys} in config) mm_help_tab=2;; commands|command) mm_help_tab=3;; esac
  while (( ${mm_running:-1} )); do
    _mm_size
    mm_help_rows=${LINES:-24}
    mm_help_cols=${COLUMNS:-80}
    (( mm_help_rows < 1 )) && mm_help_rows=1
    (( mm_help_cols < 4 )) && mm_help_cols=4
    mm_help_body=$((mm_help_rows - 5))
    (( mm_help_body < 1 )) && mm_help_body=1
    _mm_help_lines "$mm_help_tabs[$mm_help_tab]"
    mm_help_render_lines=()
    for mm_help_line in "${mm_help_lines[@]}"; do
      _mm_wrap "$mm_help_line" $((mm_help_cols - 4))
      mm_help_render_lines+=( "${(@f)REPLY}" )
    done
    mm_help_max_offset=$(( ${#mm_help_render_lines} - mm_help_body ))
    (( mm_help_max_offset < 0 )) && mm_help_max_offset=0
    (( mm_help_offset > mm_help_max_offset )) && mm_help_offset=$mm_help_max_offset
    (( mm_help_offset < 0 )) && mm_help_offset=0
    case $mm_help_tab in
      1) mm_help_title='[快捷键]  配置  命令';;
      2) mm_help_title='快捷键  [配置]  命令';;
      3) mm_help_title='快捷键  配置  [命令]';;
    esac
    print -rn -- $'\e[?25l\e[H\e[2J'
    _mm_at 1 2 $'\e[1;38;5;117mmm 帮助\e[0m'
    _mm_clip "$mm_help_title" 0 $((mm_help_cols - 3))
    (( mm_help_rows >= 2 )) && _mm_at 2 2 "$REPLY"
    mm_help_screen_row=3
    for (( mm_help_index=mm_help_offset+1; mm_help_index<=${#mm_help_render_lines} && mm_help_screen_row<=mm_help_rows-3; ++mm_help_index )); do
      _mm_at $mm_help_screen_row 2 "$mm_help_render_lines[$mm_help_index]"
      (( ++mm_help_screen_row ))
    done
    if (( mm_help_rows >= 6 )); then
      mm_help_footer="第 $((mm_help_offset + 1))–$((mm_help_index - 1)) / ${#mm_help_render_lines} 行 · Enter 保留此页"
      _mm_clip "$mm_help_footer" 0 $((mm_help_cols - 3))
      _mm_at $((mm_help_rows - 2)) 2 "$REPLY"
      _mm_clip '↑↓ 滚动 · PgUp/PgDn 翻页 · ←→/Tab 切主题' 0 $((mm_help_cols - 3))
      _mm_at $((mm_help_rows - 1)) 2 "$REPLY"
    fi
    _mm_clip '? / ？ / F1 / Esc / q / Ctrl-C 返回' 0 $((mm_help_cols - 3))
    _mm_at $mm_help_rows 2 "$REPLY"
    _mm_key
    mm_help_key=$REPLY
    case $mm_help_key in
      '?'|'？'|F1|ESC|q|CANCEL|EOF|HELP) return 0;;
      ENTER|TIMEOUT) continue;;
      UP) (( --mm_help_offset ));;
      DOWN) (( ++mm_help_offset ));;
      PAGEUP) (( mm_help_offset -= mm_help_body ));;
      PAGEDOWN) (( mm_help_offset += mm_help_body ));;
      HOME) mm_help_offset=0;;
      END) mm_help_offset=$mm_help_max_offset;;
      RIGHT|TAB) mm_help_tab=$((mm_help_tab % 3 + 1)); mm_help_offset=0;;
      LEFT|BACKTAB) mm_help_tab=$(((mm_help_tab + 1) % 3 + 1)); mm_help_offset=0;;
    esac
  done
  return 0
}

_mm_cli_help() {
  emulate -L zsh
  print -r -- 'mm — 终端脑图：输入节点，自动布局；长节点完整折行。'
  print -r -- ''
  print -r -- '用法'
  print -r -- '  mm                         新建脑图'
  print -r -- '  mm [--] [FILE]             打开或新建指定文件'
  print -r -- '  mm help / mm --help        显示此说明'
  print -r -- '  mm config [list|get KEY|set KEY VALUE|reset [KEY]|path]'
  print -r -- '  mm keys [list|bind ACTION KEY|reset [ACTION]]'
  print -r -- ''
  print -r -- '配置'
  print -r -- '  save-dir        默认保存目录；默认当前工作目录'
  print -r -- '  node-width      节点每行列宽，8–80，默认 32；汉字通常占 2 列'
  print -r -- '  key.ACTION      对应动作的主快捷键'
  print -r -- '  mm config set save-dir "/路径/脑图"'
  print -r -- '  mm config set node-width 40'
  print -r -- '  mm keys bind help H'
  print -r -- '  mm config reset [KEY]      恢复全部或单项配置'
  print -r -- '  mm keys reset [ACTION]     恢复全部或单个动作快捷键'
  print -r -- '  mm config path             输出实际配置文件路径'
  print -r -- '  配置路径：MM_CONFIG_FILE → XDG_CONFIG_HOME/mm/config → ~/.config/mm/config。'
  print -r -- ''
  print -r -- '脑图内按 : 输入命令'
  print -r -- '  :help                    打开帮助'
  print -r -- '  :config                  查看当前配置'
  print -r -- '  :set KEY VALUE           修改配置'
  print -r -- '  :bind ACTION KEY         修改动作主键'
  print -r -- '  :reset [KEY]             恢复全部或单项配置'
  print -r -- '  :keys                    查看当前快捷键'
  print -r -- '  :write [PATH]            保存；可指定文件路径'
  print -r -- '  :quit                    退出；未保存时询问'
  print -r -- '  路径含空格时请加引号。Esc / Ctrl-C 取消命令输入。'
  print -r -- ''
  print -r -- '可绑定动作 ACTION'
  print -r -- '  child sibling edit parent child-select up down fold delete'
  print -r -- '  undo redo save save-as quit help page-up page-down'
  print -r -- '  键名示例：Tab Enter Space Up Down Left Right PageUp PageDown 或单个字符。'
  print -r -- '  常用别名 a/o/h/l/k/j/Delete/Ctrl-S 保留，自定义主键优先。'
  print -r -- '  F1 帮助与 : 命令入口固定保留，不能解绑。'
  print -r -- ''
  print -r -- '帮助与编辑'
  print -r -- '  默认 ? 打开帮助；？ / F1 始终可打开帮助。'
  print -r -- '  帮助内 ↑↓ 滚动、PgUp/PgDn 翻页、←→/Tab 切主题。'
  print -r -- '  帮助内 ? / ？ / F1 / Esc / q / Ctrl-C 返回；Enter 不关闭帮助。'
  print -r -- '  编辑节点：Enter 确认，Esc / Ctrl-C 取消，Ctrl-U 清空。'
  print -r -- '  当前主快捷键、实际保存目录与节点列宽可在帮助页查看。'
  print -r -- '  只需系统 Zsh 与 UTF-8 终端；无需 PHP、Python、Node 或外部运行命令。'
  return 0
}
