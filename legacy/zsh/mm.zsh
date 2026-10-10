#!/bin/zsh
# mm: pure Zsh terminal mind map. Source this file, or copy its mm() function.
mm() {
  emulate -L zsh
  setopt localtraps
  trap '' INT
  (
  emulate -LR zsh
  setopt multibyte
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
# Pure Zsh layout and terminal-column helpers. The caller owns all mm_* data
# arrays and supplies _mm_put x y text style for viewport-aware rendering.

_mm_char_width() {
  emulate -L zsh
  setopt multibyte
  local -i mm_cp=0
  printf -v mm_cp '%d' "'$1"
  if (( mm_cp < 32 || (mm_cp >= 127 && mm_cp < 160) )); then
    REPLY=0
  elif (( (mm_cp >= 0x0300 && mm_cp <= 0x036f) ||
          (mm_cp >= 0x0483 && mm_cp <= 0x0489) ||
          (mm_cp >= 0x1ab0 && mm_cp <= 0x1aff) ||
          (mm_cp >= 0x1dc0 && mm_cp <= 0x1dff) ||
          (mm_cp >= 0x200b && mm_cp <= 0x200f) ||
          (mm_cp >= 0x202a && mm_cp <= 0x202e) ||
          (mm_cp >= 0x2060 && mm_cp <= 0x206f) ||
          (mm_cp >= 0x20d0 && mm_cp <= 0x20ff) ||
          (mm_cp >= 0xfe00 && mm_cp <= 0xfe0f) ||
          (mm_cp >= 0xfe20 && mm_cp <= 0xfe2f) ||
          (mm_cp >= 0xe0100 && mm_cp <= 0xe01ef) )); then
    REPLY=0
  elif (( mm_cp >= 0x1100 &&
          (mm_cp <= 0x115f || mm_cp == 0x2329 || mm_cp == 0x232a ||
           (mm_cp >= 0x2e80 && mm_cp <= 0xa4cf && mm_cp != 0x303f) ||
           (mm_cp >= 0xac00 && mm_cp <= 0xd7a3) ||
           (mm_cp >= 0xf900 && mm_cp <= 0xfaff) ||
           (mm_cp >= 0xfe10 && mm_cp <= 0xfe19) ||
           (mm_cp >= 0xfe30 && mm_cp <= 0xfe6f) ||
           (mm_cp >= 0xff00 && mm_cp <= 0xff60) ||
           (mm_cp >= 0xffe0 && mm_cp <= 0xffe6) ||
           (mm_cp >= 0x1f300 && mm_cp <= 0x1faff) ||
           (mm_cp >= 0x20000 && mm_cp <= 0x3fffd)) )); then
    REPLY=2
  else
    REPLY=1
  fi
  return 0
}

_mm_width() {
  emulate -L zsh
  setopt multibyte
  local mm_string=$1 mm_character
  local -i mm_index mm_columns=0
  for (( mm_index=1; mm_index<=${#mm_string}; ++mm_index )); do
    mm_character=$mm_string[$mm_index]
    _mm_char_width "$mm_character"
    (( mm_columns += REPLY ))
  done
  REPLY=$mm_columns
  return 0
}

# start_column is zero-based. Partial wide characters become spaces so the
# returned text keeps its exact position when either viewport edge bisects one.
_mm_clip() {
  emulate -L zsh
  setopt multibyte
  local mm_string=$1 mm_character mm_result=''
  local -i mm_start=$2 mm_limit=$3 mm_end mm_pos=0 mm_width_now
  local -i mm_index mm_left mm_right mm_pad mm_keep_marks=0
  (( mm_start < 0 )) && mm_start=0
  if (( mm_limit <= 0 )); then
    REPLY=''
    return 0
  fi
  (( mm_end = mm_start + mm_limit ))
  for (( mm_index=1; mm_index<=${#mm_string}; ++mm_index )); do
    mm_character=$mm_string[$mm_index]
    _mm_char_width "$mm_character"
    mm_width_now=$REPLY
    if (( mm_width_now == 0 )); then
      if (( mm_keep_marks )) && [[ $mm_character != [[:cntrl:]] ]]; then
        mm_result+=$mm_character
      fi
      continue
    fi
    (( mm_pos >= mm_end )) && break
    mm_keep_marks=0
    if (( mm_pos + mm_width_now > mm_start )); then
      if (( mm_pos >= mm_start && mm_pos + mm_width_now <= mm_end )); then
        mm_result+=$mm_character
        mm_keep_marks=1
      else
        (( mm_left = mm_pos > mm_start ? mm_pos : mm_start ))
        (( mm_right = mm_pos + mm_width_now < mm_end ? mm_pos + mm_width_now : mm_end ))
        for (( mm_pad=mm_left; mm_pad<mm_right; ++mm_pad )); do
          mm_result+=' '
        done
      fi
    fi
    (( mm_pos += mm_width_now ))
  done
  REPLY=$mm_result
  return 0
}

# Keep every source character. Whitespace is never stripped: a wrap inserts
# only a newline, so joining the generated lines recovers a single-line input.
# Whole ASCII words move together when possible; oversized words split by
# terminal columns. Two columns is the minimum so a Chinese glyph always fits.
_mm_wrap() {
  emulate -L zsh
  setopt multibyte
  local mm_string=$1 mm_result='' mm_token mm_character
  local -i mm_limit=${2:-32} mm_index=1 mm_next mm_token_width
  local -i mm_line_width=0 mm_char_width_now mm_token_index
  (( mm_limit < 2 )) && mm_limit=2
  while (( mm_index <= ${#mm_string} )); do
    mm_character=$mm_string[$mm_index]
    if [[ $mm_character == $'\n' ]]; then
      mm_result+=$'\n'
      mm_line_width=0
      (( ++mm_index ))
      continue
    fi
    mm_next=$((mm_index + 1))
    if [[ $mm_character == [A-Za-z0-9_] ]]; then
      while (( mm_next <= ${#mm_string} )) && [[ $mm_string[$mm_next] == [A-Za-z0-9_] ]]; do
        (( ++mm_next ))
      done
    fi
    mm_token=${mm_string[$mm_index,$((mm_next - 1))]}
    _mm_width "$mm_token"
    mm_token_width=$REPLY
    if (( mm_token_width <= mm_limit )); then
      if (( mm_line_width + mm_token_width > mm_limit )); then
        mm_result+=$'\n'
        mm_line_width=0
      fi
      mm_result+=$mm_token
      (( mm_line_width += mm_token_width ))
    else
      for (( mm_token_index=1; mm_token_index<=${#mm_token}; ++mm_token_index )); do
        mm_character=$mm_token[$mm_token_index]
        _mm_char_width "$mm_character"
        mm_char_width_now=$REPLY
        if (( mm_line_width + mm_char_width_now > mm_limit )); then
          mm_result+=$'\n'
          mm_line_width=0
        fi
        mm_result+=$mm_character
        (( mm_line_width += mm_char_width_now ))
      done
    fi
    mm_index=$mm_next
  done
  REPLY=$mm_result
  return 0
}

_mm_layout() {
  emulate -L zsh
  setopt multibyte
  local -a mm_stack mm_is_visible mm_level_width mm_level_x
  local -a mm_child_list mm_child_ids mm_child_span mm_subtree_height
  local -a mm_band_top mm_lines
  local mm_body mm_suffix mm_line
  local -i mm_id mm_par mm_dep mm_slot mm_child mm_line_width
  local -i mm_max_depth=0 mm_index mm_end_x mm_span mm_cursor mm_root_cursor=0
  local -i mm_wrap_limit=${mm_wrap_width:-32} mm_screen_limit
  (( mm_wrap_limit < 2 )) && mm_wrap_limit=2
  if (( ${mm_cols:-0} > 0 )); then
    mm_screen_limit=$((mm_cols - 4))
    (( mm_screen_limit < 2 )) && mm_screen_limit=2
    (( mm_wrap_limit > mm_screen_limit )) && mm_wrap_limit=$mm_screen_limit
  fi
  mm_parent=() mm_visible=() mm_x=() mm_y=() mm_w=() mm_label=()
  mm_h=() mm_top=()
  mm_total_width=0 mm_total_height=0

  for (( mm_id=1; mm_id<=${#mm_text}; ++mm_id )); do
    mm_dep=${mm_depth[$mm_id]:-0}
    (( mm_dep < 0 )) && mm_dep=0
    mm_par=0
    (( mm_dep > 0 )) && mm_par=${mm_stack[$mm_dep]:-0}
    mm_parent[$mm_id]=$mm_par
    mm_stack[$((mm_dep + 1))]=$mm_id
    if (( mm_par == 0 || (mm_is_visible[mm_par] && !mm_fold[mm_par]) )); then
      mm_is_visible[$mm_id]=1
      mm_visible+=( $mm_id )
      (( mm_dep > mm_max_depth )) && mm_max_depth=$mm_dep
      if (( mm_par > 0 )); then
        mm_child_list[$mm_par]+="$mm_id "
      fi
      mm_suffix=''
      (( mm_fold[mm_id] )) && mm_suffix=' [+]'
      mm_body="${mm_text[$mm_id]}${mm_suffix}"
      _mm_wrap "$mm_body" $mm_wrap_limit
      mm_label[$mm_id]=$REPLY
      mm_lines=( "${(@f)mm_label[$mm_id]}" )
      mm_h[$mm_id]=${#mm_lines}
      mm_w[$mm_id]=1
      for mm_line in "${mm_lines[@]}"; do
        _mm_width "$mm_line"
        mm_line_width=$REPLY
        (( mm_line_width > mm_w[mm_id] )) && mm_w[$mm_id]=$mm_line_width
      done
      mm_slot=$((mm_dep + 1))
      if (( mm_w[mm_id] > mm_level_width[mm_slot] )); then
        mm_level_width[$mm_slot]=$mm_w[$mm_id]
      fi
    else
      mm_is_visible[$mm_id]=0
    fi
  done

  mm_level_x[1]=0
  for (( mm_slot=2; mm_slot<=mm_max_depth+1; ++mm_slot )); do
    mm_level_x[$mm_slot]=$((mm_level_x[mm_slot-1] + mm_level_width[mm_slot-1] + 6))
  done
  for mm_id in $mm_visible; do
    mm_dep=${mm_depth[$mm_id]:-0}
    (( mm_dep < 0 )) && mm_dep=0
    mm_x[$mm_id]=$mm_level_x[$((mm_dep + 1))]
    (( mm_end_x = mm_x[mm_id] + mm_w[mm_id] ))
    (( mm_end_x > mm_total_width )) && mm_total_width=$mm_end_x
  done

  # Bottom-up: reserve enough vertical space for the complete text block and
  # every child subtree, with one unused row between sibling subtrees.
  for (( mm_index=${#mm_visible}; mm_index>=1; --mm_index )); do
    mm_id=$mm_visible[$mm_index]
    mm_span=${mm_child_span[$mm_id]:-0}
    (( mm_span > 0 )) && (( --mm_span ))
    mm_child_span[$mm_id]=$mm_span
    mm_subtree_height[$mm_id]=$((mm_span > mm_h[mm_id] ? mm_span : mm_h[mm_id]))
    mm_par=$mm_parent[$mm_id]
    if (( mm_par > 0 )); then
      (( mm_child_span[mm_par] += mm_subtree_height[mm_id] + 1 ))
    fi
  done

  # Top-down: center both the node and its child group inside that reserved
  # band. The connector uses the node's middle text row as its anchor.
  for mm_id in $mm_visible; do
    if (( mm_parent[mm_id] == 0 )); then
      mm_band_top[$mm_id]=$mm_root_cursor
      (( mm_root_cursor += mm_subtree_height[mm_id] + 1 ))
    fi
    mm_top[$mm_id]=$((mm_band_top[mm_id] + (mm_subtree_height[mm_id] - mm_h[mm_id]) / 2))
    mm_y[$mm_id]=$((mm_top[mm_id] + (mm_h[mm_id] - 1) / 2))
    mm_cursor=$((mm_band_top[mm_id] + (mm_subtree_height[mm_id] - mm_child_span[mm_id]) / 2))
    mm_child_ids=( ${=mm_child_list[$mm_id]} )
    for mm_child in $mm_child_ids; do
      mm_band_top[$mm_child]=$mm_cursor
      (( mm_cursor += mm_subtree_height[mm_child] + 1 ))
    done
  done
  (( mm_root_cursor > 0 )) && mm_total_height=$((mm_root_cursor - 1))
  return 0
}

_mm_draw() {
  emulate -L zsh
  local -a mm_child_list mm_child_ids mm_lines
  local -A mm_child_rows
  local mm_glyph mm_node_style mm_line
  local -i mm_id mm_par mm_child mm_trunk mm_connector_top mm_bottom mm_row mm_col
  local -i mm_has_left mm_has_right mm_line_index mm_padding
  for mm_id in $mm_visible; do
    mm_par=$mm_parent[$mm_id]
    (( mm_par > 0 )) && mm_child_list[$mm_par]+="$mm_id "
  done

  # Draw each parent's complete connector once, preserving all junctions.
  for mm_id in $mm_visible; do
    [[ -z $mm_child_list[$mm_id] ]] && continue
    mm_child_ids=( ${=mm_child_list[$mm_id]} )
    mm_child_rows=()
    mm_trunk=$((mm_x[mm_child_ids[1]] - 3))
    mm_connector_top=$mm_y[$mm_id]
    mm_bottom=$mm_connector_top
    for mm_child in $mm_child_ids; do
      mm_row=$mm_y[$mm_child]
      mm_child_rows[$mm_row]=1
      (( mm_row < mm_connector_top )) && mm_connector_top=$mm_row
      (( mm_row > mm_bottom )) && mm_bottom=$mm_row
      for (( mm_col=mm_trunk+1; mm_col<mm_x[mm_child]; ++mm_col )); do
        _mm_put $mm_col $mm_row '─' edge
      done
    done
    for (( mm_col=mm_x[mm_id]+mm_w[mm_id]; mm_col<mm_trunk; ++mm_col )); do
      _mm_put $mm_col $mm_y[$mm_id] '─' edge
    done
    for (( mm_row=mm_connector_top; mm_row<=mm_bottom; ++mm_row )); do
      mm_has_left=$((mm_row == mm_y[mm_id]))
      mm_has_right=${mm_child_rows[$mm_row]:-0}
      mm_glyph='│'
      if (( mm_connector_top == mm_bottom )); then
        mm_glyph='─'
      elif (( mm_row == mm_connector_top )); then
        if (( mm_has_left && mm_has_right )); then mm_glyph='┬'
        elif (( mm_has_left )); then mm_glyph='┐'
        else mm_glyph='┌'; fi
      elif (( mm_row == mm_bottom )); then
        if (( mm_has_left && mm_has_right )); then mm_glyph='┴'
        elif (( mm_has_left )); then mm_glyph='┘'
        else mm_glyph='└'; fi
      elif (( mm_has_left && mm_has_right )); then mm_glyph='┼'
      elif (( mm_has_left )); then mm_glyph='┤'
      elif (( mm_has_right )); then mm_glyph='├'
      fi
      _mm_put $mm_trunk $mm_row "$mm_glyph" edge
    done
  done
  for mm_id in $mm_visible; do
    mm_node_style=node
    (( mm_id == mm_selected )) && mm_node_style=selected
    mm_lines=( "${(@f)mm_label[$mm_id]}" )
    mm_line_index=0
    for mm_line in "${mm_lines[@]}"; do
      if [[ $mm_node_style == selected ]]; then
        _mm_width "$mm_line"
        mm_padding=$((mm_w[mm_id] - REPLY))
        while (( mm_padding-- > 0 )); do mm_line+=' '; done
      fi
      _mm_put $mm_x[$mm_id] $((mm_top[mm_id] + mm_line_index)) "$mm_line" "$mm_node_style"
      (( ++mm_line_index ))
    done
  done
  return 0
}
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
  _mm_main "$@"
  )
}
if [[ $ZSH_EVAL_CONTEXT == toplevel ]]; then mm "$@"; fi
