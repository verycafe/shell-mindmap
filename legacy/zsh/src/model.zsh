# Plain-text tree model for mm. All runtime operations use Zsh builtins.
# Public state is dynamically scoped by the calling mm function.

_mm_validate_label() {
  emulate -L zsh
  local label=${1-}
  if [[ -z $label || $label != *[^[:space:]]* ]]; then
    mm_message='节点文字不能为空'
    return 1
  fi
  if (( ${#label} > 300 )); then
    mm_message='节点文字最多 300 个字符'
    return 1
  fi
  if [[ $label == *[[:cntrl:]]* ]]; then
    mm_message='节点文字不能包含换行、Tab 或控制字符'
    return 1
  fi
  return 0
}

_mm_validate_state() {
  emulate -L zsh
  local -i count=${#mm_text} row previous=0 depth
  if (( count < 1 || count > 500 || ${#mm_depth} != count || ${#mm_fold} != count )); then
    mm_message='脑图必须包含 1–500 个节点，且各字段数量一致'
    return 1
  fi
  for (( row=1; row<=count; row++ )); do
    if [[ ${mm_depth[row]} != <-> || ${#mm_depth[row]} -gt 2 ||
          ( ${mm_fold[row]} != 0 && ${mm_fold[row]} != 1 ) ]]; then
      mm_message="第 $row 个节点的层级或折叠状态无效"
      return 1
    fi
    depth=${mm_depth[row]}
    if (( depth > 23 || (row == 1 && depth != 0) ||
          (row > 1 && (depth == 0 || depth > previous + 1)) )); then
      mm_message="第 $row 个节点的层级无效；最多 24 层且仅允许一个根节点"
      return 1
    fi
    _mm_validate_label "${mm_text[row]}" || return 1
    previous=$depth
  done
  return 0
}

# REPLY is local in each caller; snapshots never contain executable code.
_mm_snapshot() {
  emulate -L zsh
  local -i row
  REPLY="${mm_selected}"$'\n'
  for (( row=1; row<=${#mm_text}; row++ )); do
    REPLY+="${mm_depth[row]}"$'\t'"${mm_fold[row]}"$'\t'"${mm_text[row]}"$'\n'
  done
}

_mm_restore_snapshot() {
  emulate -L zsh
  local snapshot=$1 line rest
  local -a lines=("${(@f)snapshot}")
  local -i row
  mm_selected=${lines[1]}
  mm_text=()
  mm_depth=()
  mm_fold=()
  for (( row=2; row<=${#lines}; row++ )); do
    line=${lines[row]}
    [[ -z $line ]] && continue
    mm_depth+=("${line%%$'\t'*}")
    rest=${line#*$'\t'}
    mm_fold+=("${rest%%$'\t'*}")
    mm_text+=("${rest#*$'\t'}")
  done
  # An undo across a save must never incorrectly claim the buffer is clean.
  mm_dirty=1
}

_mm_record_undo() {
  emulate -L zsh
  local REPLY
  _mm_snapshot
  mm_undo_stack+=("$REPLY")
  if (( ${#mm_undo_stack} > 30 )); then
    mm_undo_stack=("${mm_undo_stack[@]: -30}")
  fi
  mm_redo_stack=()
}

_mm_new() {
  emulate -L zsh
  local label=${1-}
  _mm_validate_label "$label" || return 1
  mm_text=("$label")
  mm_depth=(0)
  mm_fold=(0)
  mm_selected=1
  mm_dirty=1
  mm_undo_stack=()
  mm_redo_stack=()
  mm_message='已创建脑图'
  return 0
}

_mm_insert() {
  emulate -L zsh
  local kind=${1-} label=${2-}
  local -i count=${#mm_text} selected=$mm_selected row end depth parent
  local -a new_text new_depth new_fold
  if (( selected < 1 || selected > count )); then
    mm_message='没有选中的节点'
    return 1
  fi
  if [[ $kind != child && $kind != sibling ]]; then
    mm_message='新增节点类型必须是 child 或 sibling'
    return 1
  fi
  _mm_validate_label "$label" || return 1
  if (( count >= 500 )); then
    mm_message='脑图最多 500 个节点'
    return 1
  fi
  depth=${mm_depth[selected]}
  if [[ $kind == child ]]; then
    (( depth++ ))
    if (( depth > 23 )); then
      mm_message='脑图最多 24 层'
      return 1
    fi
    parent=$selected
  else
    if (( selected == 1 )); then
      mm_message='根节点不能添加同级节点；请添加子节点'
      return 1
    fi
    parent=$((selected - 1))
    while (( parent > 1 && mm_depth[parent] >= depth )); do
      (( parent-- ))
    done
  fi
  end=$selected
  while (( end < count && mm_depth[end+1] > mm_depth[selected] )); do
    (( end++ ))
  done
  _mm_record_undo
  mm_fold[parent]=0
  for (( row=1; row<=count; row++ )); do
    new_text+=("${mm_text[row]}")
    new_depth+=("${mm_depth[row]}")
    new_fold+=("${mm_fold[row]}")
    if (( row == end )); then
      new_text+=("$label")
      new_depth+=("$depth")
      new_fold+=(0)
    fi
  done
  mm_text=("${new_text[@]}")
  mm_depth=("${new_depth[@]}")
  mm_fold=("${new_fold[@]}")
  mm_selected=$((end + 1))
  mm_dirty=1
  mm_message='已添加节点'
  return 0
}

_mm_rename() {
  emulate -L zsh
  local label=${1-}
  if (( mm_selected < 1 || mm_selected > ${#mm_text} )); then
    mm_message='没有选中的节点'
    return 1
  fi
  _mm_validate_label "$label" || return 1
  if [[ ${mm_text[mm_selected]} == "$label" ]]; then
    mm_message='节点文字未变化'
    return 0
  fi
  _mm_record_undo
  mm_text[mm_selected]=$label
  mm_dirty=1
  mm_message='已修改节点'
  return 0
}

_mm_delete() {
  emulate -L zsh
  local -i selected=$mm_selected count=${#mm_text} end row parent
  local -a new_text new_depth new_fold
  if (( selected <= 1 || selected > count )); then
    mm_message='不能删除根节点'
    return 1
  fi
  end=$selected
  while (( end < count && mm_depth[end+1] > mm_depth[selected] )); do
    (( end++ ))
  done
  parent=$((selected - 1))
  while (( parent > 1 && mm_depth[parent] >= mm_depth[selected] )); do
    (( parent-- ))
  done
  _mm_record_undo
  for (( row=1; row<=count; row++ )); do
    if (( row >= selected && row <= end )); then
      continue
    fi
    new_text+=("${mm_text[row]}")
    new_depth+=("${mm_depth[row]}")
    new_fold+=("${mm_fold[row]}")
  done
  mm_text=("${new_text[@]}")
  mm_depth=("${new_depth[@]}")
  mm_fold=("${new_fold[@]}")
  mm_selected=$parent
  mm_dirty=1
  mm_message="已删除 $((end - selected + 1)) 个节点；可按 u 撤销"
  return 0
}

_mm_undo() {
  emulate -L zsh
  local REPLY snapshot
  if (( ${#mm_undo_stack} == 0 )); then
    mm_message='没有可撤销的操作'
    return 1
  fi
  _mm_snapshot
  mm_redo_stack+=("$REPLY")
  snapshot=${mm_undo_stack[-1]}
  mm_undo_stack[-1]=()
  _mm_restore_snapshot "$snapshot"
  mm_message='已撤销'
  return 0
}

_mm_redo() {
  emulate -L zsh
  local REPLY snapshot
  if (( ${#mm_redo_stack} == 0 )); then
    mm_message='没有可重做的操作'
    return 1
  fi
  _mm_snapshot
  mm_undo_stack+=("$REPLY")
  snapshot=${mm_redo_stack[-1]}
  mm_redo_stack[-1]=()
  _mm_restore_snapshot "$snapshot"
  mm_message='已重做'
  return 0
}

_mm_load() {
  emulate -L zsh
  local filename=${1-} header line rest label depth_text fold_text
  local -a loaded_text loaded_depth loaded_fold
  local -i row=0 depth previous=0
  if [[ -z $filename || ! -f $filename || ! -r $filename ]]; then
    mm_message='无法读取脑图文件'
    return 1
  fi
  {
    IFS= read -r header
    if [[ $header != MM-ZSH-1 ]]; then
      mm_message='文件格式不正确：需要 MM-ZSH-1 文件头'
      return 1
    fi
    while IFS= read -r line || [[ -n $line ]]; do
      (( row++ ))
      if (( row > 500 )); then
        mm_message='脑图最多 500 个节点'
        return 1
      fi
      if [[ $line != *$'\t'*$'\t'* ]]; then
        mm_message="文件第 $((row + 1)) 行缺少字段"
        return 1
      fi
      depth_text=${line%%$'\t'*}
      rest=${line#*$'\t'}
      fold_text=${rest%%$'\t'*}
      label=${rest#*$'\t'}
      if [[ $depth_text != <-> || ${#depth_text} -gt 2 ||
            ( $fold_text != 0 && $fold_text != 1 ) ]]; then
        mm_message="文件第 $((row + 1)) 行的层级或折叠状态无效"
        return 1
      fi
      depth=$depth_text
      if (( depth > 23 || (row == 1 && depth != 0) ||
            (row > 1 && (depth == 0 || depth > previous + 1)) )); then
        mm_message="文件第 $((row + 1)) 行的层级无效；最多 24 层且仅允许一个根节点"
        return 1
      fi
      _mm_validate_label "$label" || return 1
      loaded_text+=("$label")
      loaded_depth+=("$depth")
      loaded_fold+=("$fold_text")
      previous=$depth
    done
  } < "$filename"
  if (( row == 0 )); then
    mm_message='脑图文件没有根节点'
    return 1
  fi
  mm_text=("${loaded_text[@]}")
  mm_depth=("${loaded_depth[@]}")
  mm_fold=("${loaded_fold[@]}")
  mm_selected=1
  mm_dirty=0
  mm_undo_stack=()
  mm_redo_stack=()
  mm_message='已载入脑图'
  return 0
}

_mm_save() {
  emulate -L zsh
  setopt noclobber
  local filename=${1-} directory basename temporary='' previous_umask
  local -i attempt output_fd=-1 row write_result=0 close_result=0
  _mm_validate_state || return 1
  if [[ -z $filename || -L $filename || ( -e $filename && ! -f $filename ) ]]; then
    mm_message='保存路径无效；不能覆盖符号链接、目录或特殊文件'
    return 1
  fi
  directory=${filename:h}
  basename=${filename:t}
  if [[ ! -d $directory || -z $basename ]]; then
    mm_message='保存目录不存在'
    return 1
  fi
  if ! zmodload -F zsh/files b:zf_mv b:zf_rm 2>/dev/null; then
    mm_message='当前 Zsh 缺少内建 zsh/files 模块，无法安全保存'
    return 1
  fi
  previous_umask=$(umask)
  umask 077
  {
    for (( attempt=1; attempt<=16; attempt++ )); do
      temporary="${directory}/.${basename}.mm-${$}-${RANDOM}-${RANDOM}.tmp"
      if { exec {output_fd}> "$temporary" } 2>/dev/null; then
        break
      fi
    done
  } always {
    umask "$previous_umask"
  }
  if (( output_fd < 0 )); then
    mm_message='无法在目标目录创建临时文件；原文件未修改'
    return 1
  fi
  {
    print -r -- MM-ZSH-1 || write_result=1
    for (( row=1; row<=${#mm_text}; row++ )); do
      print -r -- "${mm_depth[row]}"$'\t'"${mm_fold[row]}"$'\t'"${mm_text[row]}" || write_result=1
    done
  } >&$output_fd 2>/dev/null
  exec {output_fd}>&- || close_result=1
  if (( write_result || close_result )); then
    zf_rm -f -- "$temporary" 2>/dev/null
    mm_message='写入失败；原文件未修改'
    return 1
  fi
  if [[ -L $filename || ( -e $filename && ! -f $filename ) ]]; then
    zf_rm -f -- "$temporary" 2>/dev/null
    mm_message='目标路径已改变；未覆盖符号链接、目录或特殊文件'
    return 1
  fi
  if ! zf_mv -f -- "$temporary" "$filename" 2>/dev/null; then
    zf_rm -f -- "$temporary" 2>/dev/null
    mm_message='替换文件失败；原文件未修改'
    return 1
  fi
  mm_dirty=0
  mm_message='已保存'
  return 0
}
