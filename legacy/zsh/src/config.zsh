# mm configuration. Configuration files are data, never shell programs.
# Public state: associative mm_config, mm_message, REPLY, mm_config_file.

_mm_expand_path() {
  emulate -L zsh
  local text=${1-}
  case $text in
    '~') REPLY=$HOME ;;
    '~/'*) REPLY="${HOME}/${text#\~/}" ;;
    *) REPLY=$text ;;
  esac
  return 0
}

_mm_config_default() {
  emulate -L zsh
  case ${1-} in
    save-dir) REPLY='' ;;
    node-width) REPLY=32 ;;
    key.child) REPLY=Tab ;;
    key.sibling) REPLY=Enter ;;
    key.edit) REPLY=e ;;
    key.parent) REPLY=Left ;;
    key.child-select) REPLY=Right ;;
    key.up) REPLY=Up ;;
    key.down) REPLY=Down ;;
    key.fold) REPLY=Space ;;
    key.delete) REPLY=d ;;
    key.undo) REPLY=u ;;
    key.redo) REPLY=r ;;
    key.save) REPLY=s ;;
    key.save-as) REPLY=S ;;
    key.quit) REPLY=q ;;
    key.help) REPLY='?' ;;
    key.page-up) REPLY=PageUp ;;
    key.page-down) REPLY=PageDown ;;
    *) mm_message='未知配置项；使用 mm config 查看可配置项'; return 1 ;;
  esac
  return 0
}

# The caller declares config_defaults locally; no additional public state.
_mm_config_defaults() {
  emulate -L zsh
  config_defaults=(
    save-dir '' node-width 32
    key.child Tab key.sibling Enter key.edit e
    key.parent Left key.child-select Right key.up Up key.down Down
    key.fold Space key.delete d key.undo u key.redo r
    key.save s key.save-as S key.quit q key.help '?'
    key.page-up PageUp key.page-down PageDown
  )
}

_mm_config_resolve_file() {
  emulate -L zsh
  local target=${MM_CONFIG_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/mm/config} REPLY
  if [[ $target == *[[:cntrl:]]* ]]; then
    mm_message='配置文件路径不能包含控制字符'
    return 1
  fi
  _mm_expand_path "$target"
  mm_config_file=${REPLY:a}
  return 0
}

_mm_config_validate_value() {
  emulate -L zsh
  local key=${1-} value=${2-} mode=${3:-set} expanded
  _mm_config_default "$key" || return 1
  if [[ $value == *[[:cntrl:]]* ]]; then
    mm_message="配置 $key 不能包含 Tab、换行或控制字符"
    return 1
  fi
  case $key in
    save-dir)
      if [[ -z $value ]]; then
        REPLY=''
        return 0
      fi
      _mm_expand_path "$value"
      expanded=${REPLY:a}
      if [[ $mode == set && ( ! -d $expanded || ! -w $expanded ) ]]; then
        mm_message='save-dir 必须是现存且可写的目录'
        return 1
      fi
      REPLY=$expanded
      ;;
    node-width)
      if [[ $value != <-> || ${#value} -gt 2 ]]; then
        mm_message='node-width 必须是 8–80 之间的整数'
        return 1
      fi
      if (( 10#$value < 8 || 10#$value > 80 )); then
        mm_message='node-width 必须是 8–80 之间的整数'
        return 1
      fi
      REPLY=$((10#$value))
      ;;
    key.*)
      case $value in
        ':'|'：'|'？')
          mm_message=':、中文：和中文？是固定入口，不能重新分配'
          return 1
          ;;
        F1)
          if [[ $key != key.help ]]; then
            mm_message='F1 是固定帮助入口，只能用于 key.help'
            return 1
          fi
          ;;
        Tab|Enter|Left|Right|Up|Down|Space|Delete|PageUp|PageDown) ;;
        *)
          if (( ${#value} != 1 )) || [[ $value != [[:graph:]] ]]; then
            mm_message="配置 $key 需要单个可见字符或命名按键（如 Tab、Enter、Left、Space）"
            return 1
          fi
          ;;
      esac
      REPLY=$value
      ;;
  esac
  return 0
}

_mm_config_check_bindings() {
  emulate -L zsh
  local -A proposed=("$@") assigned=()
  local key binding previous
  for key in "${(@ok)proposed}"; do
    [[ $key == key.* ]] || continue
    binding=${proposed[$key]}
    if (( ${+assigned[$binding]} )); then
      previous=${assigned[$binding]}
      mm_message="快捷键冲突：$key 与 $previous 都使用 $binding；请先改绑其中一个"
      return 1
    fi
    assigned[$binding]=$key
  done
  return 0
}

_mm_config_load() {
  emulate -L zsh
  local -A config_defaults candidate seen=()
  local header line key value REPLY
  local -i line_number=1
  _mm_config_defaults
  mm_config=("${(@kv)config_defaults}")
  mm_config_file=''
  _mm_config_resolve_file || return 1
  if [[ -L $mm_config_file ]]; then
    mm_message='拒绝读取符号链接配置文件；已使用默认配置'
    return 1
  fi
  if [[ ! -e $mm_config_file ]]; then
    mm_message='已使用默认配置'
    return 0
  fi
  if [[ ! -f $mm_config_file || ! -r $mm_config_file ]]; then
    mm_message='配置文件不是可读的普通文件；已使用默认配置'
    return 1
  fi
  candidate=("${(@kv)config_defaults}")
  {
    IFS= read -r header
    if [[ $header != MM-CONFIG-1 ]]; then
      mm_message='配置文件格式错误：需要 MM-CONFIG-1 文件头；已使用默认配置'
      return 1
    fi
    while IFS= read -r line || [[ -n $line ]]; do
      (( line_number++ ))
      if (( line_number > 20 )) || [[ $line != *$'\t'* ]]; then
        mm_message="配置文件第 $line_number 行格式错误；已使用默认配置"
        return 1
      fi
      key=${line%%$'\t'*}
      value=${line#*$'\t'}
      if ! _mm_config_default "$key"; then
        mm_message="配置文件第 $line_number 行包含未知配置项；已使用默认配置"
        return 1
      fi
      if (( ${+seen[$key]} )); then
        mm_message="配置文件重复定义 $key；已使用默认配置"
        return 1
      fi
      seen[$key]=1
      if ! _mm_config_validate_value "$key" "$value" load; then
        mm_message="配置文件第 $line_number 行：$mm_message；已使用默认配置"
        return 1
      fi
      candidate[$key]=$REPLY
    done
  } < "$mm_config_file"
  if ! _mm_config_check_bindings "${(@kv)candidate}"; then
    mm_message+="；已使用默认配置"
    return 1
  fi
  mm_config=("${(@kv)candidate}")
  mm_message='已加载配置'
  return 0
}

# Persist a complete, already validated configuration. The live map is only
# changed by the caller after this function succeeds.
_mm_config_write() {
  emulate -L zsh
  setopt noclobber
  local -A proposed=("$@")
  local directory temporary='' key previous_umask
  local -i attempt output_fd=-1 write_result=0 close_result=0
  [[ -n $mm_config_file ]] || _mm_config_resolve_file || return 1
  if [[ -L $mm_config_file || ( -e $mm_config_file && ! -f $mm_config_file ) ]]; then
    mm_message='配置保存路径无效；不能覆盖符号链接、目录或特殊文件'
    return 1
  fi
  directory=${mm_config_file:h}
  if ! zmodload -F zsh/files b:zf_mkdir b:zf_mv b:zf_rm 2>/dev/null; then
    mm_message='当前 Zsh 缺少内建 zsh/files 模块，无法安全保存配置'
    return 1
  fi
  previous_umask=$(umask)
  umask 077
  {
    if ! zf_mkdir -p -- "$directory" 2>/dev/null; then
      mm_message='无法创建配置目录；配置未修改'
      return 1
    fi
    for (( attempt=1; attempt<=16; attempt++ )); do
      temporary="${directory}/.mm-config-${$}-${RANDOM}-${RANDOM}.tmp"
      if { exec {output_fd}> "$temporary" } 2>/dev/null; then
        break
      fi
    done
  } always {
    umask "$previous_umask"
  }
  if (( output_fd < 0 )); then
    mm_message='无法创建配置临时文件；配置未修改'
    return 1
  fi
  {
    print -r -- MM-CONFIG-1 || write_result=1
    for key in "${(@ok)proposed}"; do
      print -r -- "$key"$'\t'"${proposed[$key]}" || write_result=1
    done
  } >&$output_fd 2>/dev/null
  exec {output_fd}>&- || close_result=1
  if (( write_result || close_result )); then
    zf_rm -f -- "$temporary" 2>/dev/null
    mm_message='写入配置失败；原文件和当前配置未修改'
    return 1
  fi
  if [[ -L $mm_config_file || ( -e $mm_config_file && ! -f $mm_config_file ) ]]; then
    zf_rm -f -- "$temporary" 2>/dev/null
    mm_message='配置路径已改变；原文件和当前配置未修改'
    return 1
  fi
  if ! zf_mv -f -- "$temporary" "$mm_config_file" 2>/dev/null; then
    zf_rm -f -- "$temporary" 2>/dev/null
    mm_message='替换配置文件失败；原文件和当前配置未修改'
    return 1
  fi
  return 0
}

_mm_config_set() {
  emulate -L zsh
  local key=${1-} value=${2-} REPLY
  local -A candidate=("${(@kv)mm_config}")
  _mm_config_validate_value "$key" "$value" set || return 1
  candidate[$key]=$REPLY
  _mm_config_check_bindings "${(@kv)candidate}" || return 1
  _mm_config_write "${(@kv)candidate}" || return 1
  mm_config=("${(@kv)candidate}")
  mm_message="已保存配置：$key"
  return 0
}

_mm_config_reset() {
  emulate -L zsh
  local key=${1-} entry REPLY
  local -A config_defaults candidate
  if [[ $key == keys ]]; then
    _mm_config_defaults
    candidate=("${(@kv)mm_config}")
    for entry in "${(@k)config_defaults}"; do
      [[ $entry == key.* ]] || continue
      candidate[$entry]=${config_defaults[$entry]}
    done
  elif [[ -n $key ]]; then
    _mm_config_default "$key" || return 1
    candidate=("${(@kv)mm_config}")
    candidate[$key]=$REPLY
  else
    _mm_config_defaults
    candidate=("${(@kv)config_defaults}")
  fi
  _mm_config_check_bindings "${(@kv)candidate}" || return 1
  _mm_config_write "${(@kv)candidate}" || return 1
  mm_config=("${(@kv)candidate}")
  case $key in
    '') mm_message='已恢复全部默认配置' ;;
    keys) mm_message='已恢复全部默认快捷键' ;;
    *) mm_message="已恢复默认配置：$key" ;;
  esac
  return 0
}

_mm_config_get() {
  emulate -L zsh
  local key=${1-}
  _mm_config_default "$key" || return 1
  REPLY=${mm_config[$key]}
  return 0
}

_mm_config_show() {
  emulate -L zsh
  local key
  for key in "${(@ok)mm_config}"; do
    print -r -- "$key=${mm_config[$key]}"
  done
  return 0
}
