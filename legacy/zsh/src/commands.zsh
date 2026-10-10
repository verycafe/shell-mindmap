# Command-line configuration and the in-app command prompt. No eval or shell execution.
_mm_key_name() {
  emulate -L zsh
  case $1 in
    TAB) REPLY=Tab;; ENTER) REPLY=Enter;;
    LEFT) REPLY=Left;; RIGHT) REPLY=Right;; UP) REPLY=Up;; DOWN) REPLY=Down;;
    ' ') REPLY=Space;; DELETE) REPLY=Delete;;
    PAGEUP) REPLY=PageUp;; PAGEDOWN) REPLY=PageDown;;
    *) REPLY=$1;;
  esac
}

_mm_action() {
  emulate -L zsh
  local pressed=$1 action canonical
  case $pressed in
    F1|'？') REPLY=help; return 0;;
    ':'|'：') REPLY=command; return 0;;
    CANCEL|EOF) REPLY=quit; return 0;;
  esac
  _mm_key_name "$pressed"; canonical=$REPLY
  for action in child sibling edit parent child-select up down fold delete undo redo save save-as quit help page-up page-down; do
    if [[ ${mm_config[key.$action]} == "$canonical" ]]; then
      REPLY=$action
      return 0
    fi
  done
  # Convenience aliases only apply when no configured primary key owns them.
  case $pressed in
    a) REPLY=child;; o) REPLY=sibling;; h) REPLY=parent;; l) REPLY=child-select;;
    k) REPLY=up;; j) REPLY=down;; DELETE) REPLY=delete;; SAVE) REPLY=save;;
    *) REPLY='';;
  esac
}

_mm_keys_list() {
  emulate -L zsh
  local action
  for action in child sibling edit parent child-select up down fold delete undo redo save save-as quit help page-up page-down; do
    printf '%-14s %s\n' "$action" "${mm_config[key.$action]}"
  done
  print -r -- '固定入口：F1 / 中文？ = 帮助；: / 中文： = 命令；Esc = 取消输入'
}

_mm_cli_dispatch() {
  emulate -L zsh
  local group=$1 operation=${2:-list} setting value
  case $group in
    config)
      case $operation in
        list)
          (( $# <= 2 )) || { mm_message='用法：mm config list'; return 2; }
          _mm_config_show;;
        path)
          (( $# == 2 )) || { mm_message='用法：mm config path'; return 2; }
          print -r -- "$mm_config_file";;
        get)
          (( $# == 3 )) || { mm_message='用法：mm config get KEY'; return 2; }
          _mm_config_get "$3" || return 2
          print -r -- "$REPLY";;
        set)
          (( $# == 4 )) || { mm_message='用法：mm config set KEY VALUE（含空格的值请加引号）'; return 2; }
          _mm_config_set "$3" "$4" || return 2
          print -r -- "已保存：$3 = ${mm_config[$3]}";;
        reset)
          (( $# <= 3 )) || { mm_message='用法：mm config reset [KEY]'; return 2; }
          _mm_config_reset "${3-}" || return 2
          print -r -- "已恢复默认配置：${3:-全部}";;
        *) mm_message='未知配置命令。用法：mm config list|get|set|reset|path'; return 2;;
      esac;;
    keys)
      case $operation in
        list)
          (( $# <= 2 )) || { mm_message='用法：mm keys list'; return 2; }
          _mm_keys_list;;
        bind)
          (( $# == 4 )) || { mm_message='用法：mm keys bind ACTION KEY'; return 2; }
          _mm_config_set "key.$3" "$4" || return 2
          print -r -- "已保存快捷键：$3 = $4";;
        reset)
          (( $# <= 3 )) || { mm_message='用法：mm keys reset [ACTION]'; return 2; }
          if [[ -n $3 ]]; then
            _mm_config_reset "key.$3" || return 2
          else
            # The configuration module resets all keys as one atomic change.
            _mm_config_reset keys || return 2
          fi
          print -r -- "已恢复默认快捷键：${3:-全部}";;
        *) mm_message='未知快捷键命令。用法：mm keys list|bind|reset'; return 2;;
      esac;;
  esac
  return 0
}

# Minimal literal quoting: quoted spaces and backslash escapes, no expansion.
_mm_parse_command() {
  emulate -L zsh
  local input=$1 ch word='' quote=''
  local -i index=0 escaped=0 started=0
  reply=()
  for ((index=1; index<=${#input}; index++)); do
    ch=$input[index]
    if ((escaped)); then word+=$ch; escaped=0; started=1; continue; fi
    if [[ $quote == "'" ]]; then
      if [[ $ch == "'" ]]; then quote=''; else word+=$ch; fi
      continue
    fi
    if [[ $ch == \\ ]]; then escaped=1; started=1; continue; fi
    if [[ $quote == '"' ]]; then
      if [[ $ch == '"' ]]; then quote=''; else word+=$ch; fi
      continue
    fi
    case $ch in
      "'"|'"') quote=$ch; started=1;;
      ' '|$'\t')
        if ((started)); then reply+=("$word"); word=''; started=0; fi;;
      *) word+=$ch; started=1;;
    esac
  done
  if [[ -n $quote ]] || ((escaped)); then
    mm_message='命令的引号或反斜线未闭合。请重新输入。'
    return 1
  fi
  ((started)) && reply+=("$word")
  return 0
}

_mm_resolve_save_path() {
  emulate -L zsh
  _mm_expand_path "$1"
  [[ -z $REPLY ]] && { mm_message='文件名不能为空。'; return 1; }
  if [[ $REPLY != /* && -n ${mm_config[save-dir]} ]]; then
    REPLY="${mm_config[save-dir]}/$REPLY"
  fi
  # Normalize relative paths once, so later settings do not move an open map.
  REPLY=${REPLY:a}
  return 0
}

_mm_apply_setting() {
  emulate -L zsh
  case $1 in
    node-width|'') mm_wrap_width=${mm_config[node-width]}; mm_pan=0;;
  esac
}

_mm_command_prompt() {
  emulate -L zsh
  local input verb setting value
  local -a reply
  _mm_edit '命令（help 查看用法）' '' command || return 0
  input=$REPLY
  _mm_parse_command "$input" || return 0
  (( ${#reply} )) || return 0
  verb=${reply[1]#:}
  case $verb in
    help|config|keys)
      if (( ${#reply} != 1 )); then
        mm_message="用法：:$verb"
      else
        if [[ $verb == help ]]; then _mm_help_screen commands; else _mm_help_screen "$verb"; fi
      fi;;
    set)
      if (( ${#reply} != 3 )); then
        mm_message='用法：:set KEY VALUE（含空格的路径请加引号）'
      elif _mm_config_set "$reply[2]" "$reply[3]"; then
        _mm_apply_setting "$reply[2]"
        mm_message="已保存设置：$reply[2] = ${mm_config[$reply[2]]}"
      fi;;
    bind)
      if (( ${#reply} != 3 )); then
        mm_message='用法：:bind ACTION KEY'
      elif _mm_config_set "key.$reply[2]" "$reply[3]"; then
        mm_message="快捷键已生效并保存：$reply[2] = $reply[3]"
      fi;;
    reset)
      if (( ${#reply} > 2 )); then
        mm_message='用法：:reset [KEY]'
      elif _mm_config_reset "${reply[2]-}"; then
        _mm_apply_setting "${reply[2]-}"
        mm_message="已恢复默认：${reply[2]:-全部配置}"
      fi;;
    write|w)
      if (( ${#reply} > 2 )); then
        mm_message='用法：:write [PATH]（含空格的路径请加引号）'
      elif (( ${#reply} == 2 )); then
        _mm_save_dialog to "$reply[2]"
      else
        _mm_save_dialog
      fi;;
    quit|q)
      if (( ${#reply} == 1 )); then _mm_quit; else mm_message='用法：:quit'; fi;;
    *) mm_message="未知命令：$verb。输入 :help 查看命令。";;
  esac
  return 0
}
