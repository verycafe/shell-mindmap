#!/bin/zsh
# Run with: zsh -f tests/layout.zsh
emulate -LR zsh
setopt multibyte
source "${0:A:h:h}/src/layout.zsh"

integer mm_checks=0
assert_equal() {
  emulate -L zsh
  (( ++mm_checks ))
  if [[ $1 != $2 ]]; then
    print -u2 -r -- "FAIL $3: expected <${2}>, got <${1}>"
    exit 1
  fi
}

local -a samples=(
  '中文节点的完整内容应当折行显示而不是被省略'
  'alpha  beta   gamma    delta '
  '  leading spaces and trailing spaces  '
  'abcdefghijklmnopqrstuvwxyz0123456789'
  '中文 mixed English 和中文  保留空格'
  $'cafe\u0301 中文 e\u0301'
  ''
)
local original wrapped recovered test_line
local -a test_lines
integer limit
for limit in 2 5 8 12 32; do
  for original in "${samples[@]}"; do
    _mm_wrap "$original" $limit
    wrapped=$REPLY
    recovered=${wrapped//$'\n'/}
    assert_equal "$recovered" "$original" "all characters survive width $limit"
    test_lines=( "${(@f)wrapped}" )
    for test_line in "${test_lines[@]}"; do
      _mm_width "$test_line"
      assert_equal $(( REPLY <= limit )) 1 "line fits width $limit"
    done
  done
done
_mm_wrap 'alpha beta gamma' 7
assert_equal "$REPLY" $'alpha \nbeta \ngamma' 'whole English words move together'
_mm_wrap '甲乙丙丁戊' 5
assert_equal "$REPLY" $'甲乙\n丙丁\n戊' 'Chinese column width, no inserted padding'
_mm_wrap $'a\n\nb\n' 6
assert_equal "$REPLY" $'a\n\nb\n' 'existing blank lines survive'

local -a mm_text mm_depth mm_fold mm_parent mm_visible mm_x mm_y mm_w mm_label mm_h mm_top
local -i mm_selected=2 mm_total_width mm_total_height mm_wrap_width=6 mm_cols=80
mm_text=('root' '012345678901234567890123456789' 'child' 'next')
mm_depth=(0 1 2 1)
mm_fold=(0 0 0 0)
_mm_layout
assert_equal "${(j:,:)mm_h}" '1,5,1,1' 'all wrapped text rows are measured'
assert_equal "${(j:,:)mm_top}" '3,0,2,6' 'long parent reserves its whole subtree band'
assert_equal "${(j:,:)mm_y}" '3,2,2,6' 'connectors anchor on middle text rows'
assert_equal "$mm_total_height" 7 'one blank row separates sibling subtree bands'
assert_equal "${mm_label[2]//$'\n'/}" "$mm_text[2]" 'long parent label remains complete'

local -i drawn_selected=0 drawn_nodes=0
_mm_put() {
  emulate -L zsh
  local -i draw_x=$1 draw_y=$2
  local draw_text=$3 draw_style=$4
  assert_equal $(( draw_x >= 0 && draw_x < mm_total_width )) 1 'drawing stays in horizontal world bounds'
  assert_equal $(( draw_y >= 0 && draw_y < mm_total_height )) 1 'drawing stays in vertical world bounds'
  if [[ $draw_text == *$'\n'* ]]; then
    assert_equal "$draw_text" '' 'each draw call contains only one row'
  fi
  if [[ $draw_style != edge ]]; then (( ++drawn_nodes )); fi
  if [[ $draw_style == selected ]]; then
    assert_equal "$draw_y" "$((mm_top[mm_selected] + drawn_selected))" 'selected rows are contiguous'
    _mm_width "$draw_text"
    assert_equal "$REPLY" "$mm_w[$mm_selected]" 'selected background covers uniform block width'
    (( ++drawn_selected ))
  fi
  return 0
}
_mm_draw
assert_equal "$drawn_selected" "$mm_h[$mm_selected]" 'every selected text row is drawn'
assert_equal "$drawn_nodes" 8 'all node rows are drawn'

# A short final line must still paint the selected block's entire width.
mm_text[2]='a  complete label'
_mm_layout
drawn_selected=0 drawn_nodes=0
_mm_draw
assert_equal "$drawn_selected" "$mm_h[$mm_selected]" 'ragged selected rows are padded'

# Mixed-depth tree with tall parents, tall leaves, and nested siblings.
mm_text=('根节点说明非常长需要折行' '第一组父节点本身也比较长' 'leaf' 'grandchild content wraps over several lines' '第二个叶子很长很长很长' 'group B' 'a b c d e f g h i' '中文叶子' 'last')
mm_depth=(0 1 2 3 2 1 2 2 1)
mm_fold=(0 0 0 0 0 0 0 0 0)
mm_wrap_width=7
_mm_layout
local -i first second rectangles_intersect
for first in $mm_visible; do
  assert_equal "${mm_label[$first]//$'\n'/}" "$mm_text[$first]" 'layout preserves every visible node text'
  assert_equal $(( mm_top[first] >= 0 && mm_top[first] + mm_h[first] <= mm_total_height )) 1 'whole node block lies within world height'
  for second in $mm_visible; do
    (( second <= first )) && continue
    rectangles_intersect=$((mm_x[first] < mm_x[second]+mm_w[second] && mm_x[second] < mm_x[first]+mm_w[first] && mm_top[first] < mm_top[second]+mm_h[second] && mm_top[second] < mm_top[first]+mm_h[first]))
    assert_equal "$rectangles_intersect" 0 'node rectangles do not overlap'
  done
done
mm_fold[2]=1
_mm_layout
assert_equal "${(j:,:)mm_visible}" '1,2,6,7,8,9' 'fold hides every descendant'
assert_equal "${mm_label[2]//$'\n'/}" "${mm_text[2]} [+]" 'fold suffix does not replace text'

mm_text=('窗口变窄也应保留整个节点内容') mm_depth=(0) mm_fold=(0)
mm_cols=10 mm_wrap_width=32
_mm_layout
assert_equal $(( mm_w[1] <= 6 )) 1 'label width clamps to viewport minus four'
assert_equal "${mm_label[1]//$'\n'/}" "$mm_text[1]" 'narrow viewport retains full text'
mm_text=('')
_mm_layout
assert_equal "$mm_h[1],$mm_w[1],$mm_total_height" '1,1,1' 'empty node remains one drawable row'
mm_text=() mm_depth=() mm_fold=()
_mm_layout
assert_equal "$mm_total_width,$mm_total_height,${#mm_h},${#mm_top}" '0,0,0,0' 'empty map clears dimensions'
print -r -- "PASS: $mm_checks layout, wrapping, and drawing assertions"
