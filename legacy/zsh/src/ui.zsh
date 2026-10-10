# Terminal input, viewport and application loop. Loaded inside mm's subshell.
_mm_size() {
  emulate -L zsh
  # Noninteractive Zsh does not refresh its size parameters on WINCH.
  # Reloading its bundled terminfo module asks the terminal for fresh dimensions.
  zmodload -u zsh/terminfo 2>/dev/null
  if zmodload zsh/terminfo 2>/dev/null; then
    (( ${terminfo[cols]:-0} > 0 )) && COLUMNS=${terminfo[cols]}
    (( ${terminfo[lines]:-0} > 0 )) && LINES=${terminfo[lines]}
  fi
  return 0
}

_mm_key() {
  emulate -L zsh
  setopt localtraps
  # Returning from the trap aborts read's EINTR retry instead of swallowing
  # the next key. The enclosing application stays alive to handle cancellation.
  trap 'REPLY=CANCEL; return 0' INT
  local ch tail seq=''
  local before_size="${COLUMNS}:${LINES}"
  REPLY=''
  if (( mm_interrupted )); then mm_interrupted=0; REPLY=CANCEL; return 0; fi
  while ! IFS= read -rsk 1 -t 0.05 ch; do
    if (( mm_interrupted )); then mm_interrupted=0; REPLY=CANCEL; return 0; fi
    if (( !mm_running )); then REPLY=CANCEL; return 0; fi
    _mm_size
    if [[ $before_size != "${COLUMNS}:${LINES}" ]]; then
      REPLY=TIMEOUT
      return 0
    fi
  done
  case $ch in
    $'\e')
      if IFS= read -rsk 1 -t 0.06 tail; then
        if [[ $tail == '[' || $tail == O ]]; then
          seq=$tail
          while (( ${#seq} < 16 )); do
            IFS= read -rsk 1 -t 0.06 tail || break
            seq+=$tail
            [[ $tail == [a-zA-Z~] ]] && break
          done
          case $seq in
            OP|'[11~') REPLY=F1;;
            '[A'|OA) REPLY=UP;; '[B'|OB) REPLY=DOWN;;
            '[C'|OC) REPLY=RIGHT;; '[D'|OD) REPLY=LEFT;;
            '[H'|OH|'[1~'|'[7~') REPLY=HOME;;
            '[F'|OF|'[4~'|'[8~') REPLY=END;;
            '[3~') REPLY=DELETE;; '[Z') REPLY=BACKTAB;;
            '[5~') REPLY=PAGEUP;; '[6~') REPLY=PAGEDOWN;;
            '[200~') REPLY=PASTE_START;; '[201~') REPLY=PASTE_END;;
            *) REPLY=IGNORED;;
          esac
        else
          REPLY=ESC
        fi
      else
        REPLY=ESC
      fi;;
    $'\r'|$'\n') REPLY=ENTER;;
    $'\t') REPLY=TAB;;
    $'\x7f'|$'\b') REPLY=BACKSPACE;;
    $'\x03') REPLY=CANCEL;;
    $'\x04') REPLY=EOF;;
    $'\x13') REPLY=SAVE;;
    $'\x15') REPLY=CLEAR;;
    *) REPLY=$ch;;
  esac
}

_mm_at() {
  emulate -L zsh
  printf '\e[%d;%dH%s' "$1" "$2" "$3"
}

# Convert world coordinates to screen coordinates and clip by display columns.
_mm_put() {
  emulate -L zsh
  local -i px=$(( $1 - mm_vx + 2 )) py=$(( $2 - mm_vy + 4 )) cut=0
  local out=$3 tone=$4 paint=$'\e[0m'
  (( py < 4 || py > mm_rows - 4 || px > mm_cols - 1 )) && return 0
  if (( px < 2 )); then
    cut=$(( 2 - px )); px=2
  fi
  _mm_clip "$out" $cut $(( mm_cols - px ))
  out=$REPLY
  [[ -z $out ]] && return 0
  case $tone in
    edge) paint=$'\e[38;5;60m';;
    node) paint=$'\e[38;5;153m';;
    selected) paint=$'\e[1;30;48;5;117m';;
  esac
  _mm_at $py $px "${paint}${out}"$'\e[0m'
}

_mm_render() {
  emulate -L zsh
  _mm_size
  local -i mm_rows=${LINES:-24} mm_cols=${COLUMNS:-80}
  (( mm_rows < 1 )) && mm_rows=24
  (( mm_cols < 1 )) && mm_cols=80
  local title badge='' footer="${mm_config[key.child]} 子节点 · ${mm_config[key.sibling]} 同级 · ${mm_config[key.edit]} 编辑"
  print -rn -- $'\e[?25l\e[H\e[2J'
  if (( mm_rows < 12 || mm_cols < 48 )); then
    _mm_at 1 1 'mm: 请将终端放大至至少 48 列 × 12 行。'
    _mm_at 3 1 "${mm_config[key.quit]} 退出 · F1 帮助 · : 命令"
    return 0
  fi
  _mm_layout
  (( mm_dirty )) && badge=' ●'
  title="mm${badge}  ${mm_file:-未命名脑图}"
  _mm_clip "$title" 0 $((mm_cols-4))
  _mm_at 1 2 $'\e[1;38;5;117m'"$REPLY"$'\e[0m'
  if [[ -n ${mm_edit_mode:-} ]]; then
    _mm_clip '输入中 · Enter 确认 · Esc 取消 · F1 帮助' 0 $((mm_cols-4))
  else
    _mm_clip "${mm_config[key.help]} / F1 帮助 · : 命令 · 长节点自动折行" 0 $((mm_cols-4))
  fi
  _mm_at 2 2 $'\e[2m'"$REPLY"$'\e[0m'
  local -i body_h=$((mm_rows-7)) body_w=$((mm_cols-3))
  local -i node_top=${mm_top[mm_selected]:-0} node_h=${mm_h[mm_selected]:-1}
  local -i max_vy=$(( mm_total_height > body_h ? mm_total_height-body_h : 0 ))
  if (( !mm_pan )); then
    if (( node_h > body_h || node_top < mm_vy )); then
      mm_vy=$node_top
    elif (( node_top+node_h > mm_vy+body_h )); then
      mm_vy=$(( node_top+node_h-body_h ))
    fi
  fi
  ((mm_vy > max_vy)) && mm_vy=$max_vy
  ((mm_vy < 0)) && mm_vy=0
  if (( mm_x[mm_selected] < mm_vx )); then
    mm_vx=$(( mm_x[mm_selected] > 4 ? mm_x[mm_selected]-4 : 0 ))
  elif (( mm_x[mm_selected]+mm_w[mm_selected] >= mm_vx+body_w )); then
    mm_vx=$(( mm_x[mm_selected]+mm_w[mm_selected]-body_w+1 ))
  fi
  _mm_draw
  local node_info="${mm_selected}/${#mm_text}  ${mm_text[mm_selected]}"
  _mm_clip "$node_info" 0 $((mm_cols-4))
  _mm_at $((mm_rows-3)) 2 $'\e[2m'"$REPLY"$'\e[0m'
  _mm_clip "$footer" 0 $((mm_cols-4))
  _mm_at $((mm_rows-2)) 2 "$REPLY"
  _mm_clip "${mm_message:-${mm_config[key.save]} 保存 · ${mm_config[key.undo]} 撤销 · ${mm_config[key.quit]} 退出 · : 命令}" 0 $((mm_cols-4))
  _mm_at $((mm_rows-1)) 2 $'\e[38;5;180m'"$REPLY"$'\e[0m'
}

# Inline single-line editor. Bracketed paste never triggers command shortcuts.
_mm_edit() {
  emulate -L zsh
  local prompt=$1 buffer=$2 mode=${3:-node} key ch
  local mm_edit_mode=$mode
  local -i pos=${#buffer} cursor_width=0 view_start=0 limit=0 pasted=0 cols rows max_input=300
  [[ $mode == path || $mode == command ]] && max_input=2048
  while (( mm_running )); do
    _mm_render
    cols=${COLUMNS:-80}; rows=${LINES:-24}
    (( cols < 1 )) && cols=80
    (( rows < 1 )) && rows=24
    limit=$((cols-5))
    (( limit < 10 )) && limit=10
    _mm_width "${buffer[1,pos]}"
    cursor_width=$REPLY
    view_start=$((cursor_width >= limit ? cursor_width-limit+1 : 0))
    _mm_clip "$buffer" $view_start $limit
    _mm_at $((rows-2)) 1 $'\e[2K'
    _mm_at $((rows-2)) 2 "$prompt · Enter 确认 / Esc 取消"
    _mm_at $((rows-1)) 1 $'\e[2K'
    _mm_at $((rows-1)) 2 "> $REPLY"
    _mm_at $((rows-1)) $((4+cursor_width-view_start)) $'\e[?25h'
    _mm_key; key=$REPLY
    if [[ $key == F1 ]] && (( !pasted )); then _mm_help_screen; continue; fi
    case $key in
      TIMEOUT) continue;;
      PASTE_START) pasted=1; continue;;
      PASTE_END) pasted=0; continue;;
      ESC|CANCEL|EOF) print -rn -- $'\e[?25l'; return 1;;
      ENTER) (( pasted )) || { REPLY=$buffer; print -rn -- $'\e[?25l'; return 0; };;
      LEFT) ((pos>0)) && ((pos--)); continue;;
      RIGHT) ((pos<${#buffer})) && ((pos++)); continue;;
      HOME) pos=0; continue;;
      END) pos=${#buffer}; continue;;
      CLEAR) buffer=''; pos=0; continue;;
      BACKSPACE)
        if ((pos>0)); then
          buffer="${buffer[1,pos-1]}${buffer[pos+1,-1]}"
          ((pos--))
        fi
        continue;;
      DELETE)
        ((pos<${#buffer})) && buffer="${buffer[1,pos]}${buffer[pos+2,-1]}"
        continue;;
      TAB) (( pasted )) || continue;;
      UP|DOWN|PAGEUP|PAGEDOWN|BACKTAB|SAVE|IGNORED) continue;;
    esac
    ch=$key
    [[ $key == ENTER || $key == TAB ]] && ch=' '
    [[ $ch == *[[:cntrl:]]* ]] && continue
    if (( ${#buffer} < max_input )); then
      buffer="${buffer[1,pos]}${ch}${buffer[pos+1,-1]}"
      ((pos+=${#ch}))
    else
      mm_message="输入最多 $max_input 个字符。"
    fi
  done
  return 1
}

_mm_save_dialog() {
  emulate -L zsh
  local target=$mm_file key suggested
  if [[ -z $target || $1 == as || $1 == to ]]; then
    if [[ $1 == to ]]; then
      target=$2
    else
      suggested=$mm_file
      if [[ -z $suggested ]]; then
        _mm_resolve_save_path mindmap.mm || return 1
        suggested=$REPLY
      fi
      _mm_edit '保存到文件' "$suggested" path || return 1
      target=$REPLY
    fi
    _mm_resolve_save_path "$target" || return 1
    target=$REPLY
    if [[ -e $target && $target != $mm_file ]]; then
      mm_message='该文件已存在。按 y 覆盖，其他键取消。'
      _mm_render
      while true; do
        _mm_key; key=$REPLY
        [[ $key != TIMEOUT ]] && break
        (( mm_running )) || return 1
      done
      [[ $key == y ]] || { mm_message='已取消保存。'; return 1; }
    fi
  fi
  if _mm_save "$target"; then
    mm_file=$target
    return 0
  fi
  return 1
}

_mm_quit() {
  emulate -L zsh
  local key
  if (( !mm_dirty )); then mm_running=0; return 0; fi
  mm_message='有未保存修改：s 保存退出 / d 放弃修改 / Esc 继续编辑'
  while (( mm_running )); do
    _mm_render
    _mm_key; key=$REPLY
    case $key in
      TIMEOUT) continue;;
      s|SAVE) _mm_save_dialog && mm_running=0; return 0;;
      d) mm_running=0; return 0;;
      *) mm_message='继续编辑。'; return 0;;
    esac
  done
}

_mm_main() {
  emulate -L zsh
  setopt multibyte
  local -A mm_config
  local mm_config_file='' mm_message='' REPLY=''
  local -i config_result=0
  _mm_config_load || config_result=$?
  if [[ $1 == --help || $1 == -h || $1 == help ]]; then
    _mm_cli_help
    return 0
  fi
  if ((config_result)); then
    if [[ $1 == config && $2 == reset && $# == 2 ]]; then
      _mm_cli_dispatch "$@" && return 0
    fi
    print -u2 -r -- "$mm_message"
    print -u2 -r -- '可用 mm config reset 恢复默认配置，或用 mm --help 查看说明。'
    return 2
  fi
  if [[ $1 == config || $1 == keys ]]; then
    if _mm_cli_dispatch "$@"; then return 0; fi
    print -u2 -r -- "$mm_message"
    return 2
  fi
  local -i literal_path=0
  if [[ $1 == -- ]]; then literal_path=1; shift; fi
  if (( $# > 1 )) || { (( !literal_path )) && [[ $1 == -* ]]; }; then
    print -u2 -r -- '用法：mm [--] [文件.mm]；帮助：mm --help'
    return 2
  fi
  local width_setting=${MM_NODE_WIDTH:-${mm_config[node-width]}}
  if [[ $width_setting != <-> || ${#width_setting} -gt 2 ]] ||
      (( width_setting < 8 || width_setting > 80 )); then
    print -u2 -r -- 'MM_NODE_WIDTH 必须是 8–80 的整数终端列数（一个汉字通常占 2 列）。'
    return 2
  fi
  if [[ ! -t 0 || ! -t 1 ]]; then
    print -u2 -r -- 'mm 需要交互终端。请在终端中运行 mm，查看说明用 mm --help。'
    return 2
  fi
  if [[ ${TERM:-dumb} == dumb ]]; then
    print -u2 -r -- 'mm 需要支持 ANSI 的 UTF-8 终端。'
    return 2
  fi
  # Do not let inherited exported dimensions override the actual terminal size.
  typeset +x COLUMNS LINES
  local -a mm_text mm_depth mm_fold mm_undo_stack mm_redo_stack
  local -a mm_parent mm_visible mm_x mm_y mm_w mm_h mm_top mm_label
  local -i mm_selected=1 mm_dirty=0 mm_running=1 mm_interrupted=0 mm_vx=0 mm_vy=0
  local -i mm_pan=0 mm_wrap_width=$width_setting
  local -i mm_total_width=0 mm_total_height=0 mm_new_map=0 mm_paste=0
  local mm_file=$1 key='' action='' line=''
  if [[ -n $mm_file ]]; then
    _mm_expand_path "$mm_file"
    mm_file=${REPLY:a}
  fi
  local -i selected_index=1 node=0 i=0 child=0
  if [[ -n $mm_file && ( -e $mm_file || -L $mm_file ) ]]; then
    if ! _mm_load "$mm_file"; then
      print -u2 -r -- "$mm_message"
      return 1
    fi
  else
    _mm_new '中心主题'
    mm_new_map=1
  fi
  trap 'mm_interrupted=1' INT
  trap 'mm_running=0' TERM HUP
  # Size is polled with the built-in module during read timeouts as well.
  trap ':' WINCH
  {
    print -rn -- $'\e[?1049h\e[?25l\e[?2004h'
    if ((mm_new_map)); then
      if _mm_edit '中心主题' ''; then
        [[ -n $REPLY ]] && _mm_rename "$REPLY"
      fi
    fi
    while ((mm_running)); do
      _mm_render
      _mm_key; key=$REPLY
      [[ $key == TIMEOUT ]] && continue
      if [[ $key == PASTE_START ]]; then mm_paste=1; continue; fi
      if [[ $key == PASTE_END ]]; then mm_paste=0; continue; fi
      ((mm_paste)) && continue
      mm_message=''
      _mm_action "$key"; action=$REPLY
      [[ $action != page-up && $action != page-down ]] && mm_pan=0
      selected_index=${mm_visible[(ie)$mm_selected]}
      case $action in
        page-up) mm_pan=1; ((mm_vy-= (LINES>8 ? LINES-8 : 1)));;
        page-down) mm_pan=1; ((mm_vy+= (LINES>8 ? LINES-8 : 1)));;
        quit) _mm_quit;;
        help) _mm_help_screen;;
        command) _mm_command_prompt;;
        child)
          if _mm_edit '新子节点' ''; then _mm_insert child "$REPLY"; fi;;
        sibling)
          if ((mm_selected==1)); then
            mm_message="中心主题没有同级节点；按 ${mm_config[key.child]} 添加子节点。"
          elif _mm_edit '新同级节点' ''; then _mm_insert sibling "$REPLY"; fi;;
        edit)
          if _mm_edit '编辑节点' "$mm_text[mm_selected]"; then _mm_rename "$REPLY"; fi;;
        up) ((selected_index>1)) && mm_selected=$mm_visible[selected_index-1];;
        down) ((selected_index<${#mm_visible})) && mm_selected=$mm_visible[selected_index+1];;
        parent) ((mm_selected>1)) && mm_selected=$mm_parent[mm_selected];;
        child-select)
          child=$((mm_selected+1))
          if ((child<=${#mm_text} && mm_depth[child]>mm_depth[mm_selected])); then
            mm_fold[mm_selected]=0; mm_selected=$child
          fi;;
        fold) mm_fold[mm_selected]=$((1-mm_fold[mm_selected]));;
        delete) _mm_delete;;
        undo) _mm_undo;; redo) _mm_redo;;
        save) _mm_save_dialog;; save-as) _mm_save_dialog as;;
      esac
    done
  } always {
    print -rn -- $'\e[0m\e[?2004l\e[?25h\e[?1049l'
  }
  return 0
}
