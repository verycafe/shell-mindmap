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
