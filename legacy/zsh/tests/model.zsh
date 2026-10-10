#!/bin/zsh
# Run: /bin/zsh -f tests/model.zsh
emulate -R zsh
source "${0:A:h:h}/src/model.zsh" || exit 1
zmodload zsh/files || exit 1

typeset -a mm_text mm_depth mm_fold mm_undo_stack mm_redo_stack
typeset -i mm_selected=1 mm_dirty=0 checks=0 failures=0 row
typeset mm_message='' REPLY='' before='' after='' contents=''
typeset fixture_dir="${TMPDIR:-/tmp}/mm-model-test-${$}-${RANDOM}"
zf_mkdir -- "$fixture_dir" || exit 1
# Prove runtime operations do not resolve any external command.
path=()

_check_equal() {
  emulate -L zsh
  (( checks++ ))
  if [[ $1 != "$2" ]]; then
    print -r -- "FAIL: $3 (expected <$1>, got <$2>)"
    (( failures++ ))
  fi
}

_check_failure() {
  emulate -L zsh
  local description=$1
  shift
  (( checks++ ))
  if "$@"; then
    print -r -- "FAIL: $description (unexpected success)"
    (( failures++ ))
  fi
}

_reject_file() {
  emulate -L zsh
  local description=$1 body=$2 REPLY before
  _mm_snapshot
  before=$REPLY
  print -r -- "$body" >| "$fixture_dir/invalid.mm"
  _check_failure "$description" _mm_load "$fixture_dir/invalid.mm"
  _mm_snapshot
  _check_equal "$before" "$REPLY" "$description leaves existing data intact"
}

{
  _mm_new '根节点'
  _mm_insert child '产品'
  _mm_insert child '目标用户'
  _mm_insert sibling '核心功能'
  mm_selected=2
  mm_fold[2]=1
  _mm_insert child '包含 空格、中文和 emoji 🌳'
  _check_equal 5 "$mm_selected" 'child appends after previous children'
  _check_equal 0 "${mm_fold[2]}" 'inserting child unfolds parent'
  _check_equal '0 1 2 2 2' "${mm_depth[*]}" 'preorder depths'
  mm_selected=2
  _mm_insert sibling '技术'
  _check_equal 6 "$mm_selected" 'sibling is placed after selected subtree'
  _check_equal '0 1 2 2 2 1' "${mm_depth[*]}" 'sibling depth'

  _mm_snapshot
  before=$REPLY
  mm_selected=2
  _mm_delete
  _check_equal '根节点 技术' "${mm_text[*]}" 'delete removes full subtree'
  _check_equal 1 "$mm_selected" 'deleting subtree selects parent'
  _mm_undo
  _check_equal 6 "${#mm_text}" 'undo restores subtree'
  _check_equal 2 "$mm_selected" 'undo restores selection'
  _mm_redo
  _check_equal '根节点 技术' "${mm_text[*]}" 'redo reapplies deletion'
  _mm_undo
  _mm_rename '产品已修改'
  _check_equal 0 "${#mm_redo_stack}" 'new edit clears redo'
  mm_selected=1
  _check_failure 'cannot delete root' _mm_delete
  _check_failure 'cannot add root sibling' _mm_insert sibling '第二根'
  _check_failure 'cannot use empty label' _mm_insert child ''
  _check_failure 'cannot use blank label' _mm_rename '   '
  _check_failure 'cannot use control character' _mm_rename $'name\e[2J'
  _check_failure 'cannot use tab' _mm_rename $'name\tvalue'
  _check_failure 'cannot use newline' _mm_rename $'name\nvalue'

  # Strings resembling shell syntax must remain literal data.
  _mm_insert child '\$(print PWNED > marker); `echo hi`; "quotes"; \\backslash'
  _mm_rename "\$(print PWNED > '$fixture_dir/executed')"
  mm_fold[2]=1
  _mm_snapshot
  before=$REPLY
  _mm_save "$fixture_dir/脑图 with spaces.mm"
  _check_equal 0 "$?" 'save succeeds with no PATH'
  _check_equal 0 "$mm_dirty" 'successful save marks clean'
  _mm_new '临时数据'
  _mm_load "$fixture_dir/脑图 with spaces.mm"
  _check_equal 0 "$?" 'load succeeds with no PATH'
  # Loading intentionally resets selection to root.
  after="${before#*$'\n'}"
  _mm_snapshot
  _check_equal "$after" "${REPLY#*$'\n'}" 'UTF-8, folds and literal syntax round trip'
  _check_equal 0 "$mm_dirty" 'load marks clean'
  _check_equal 0 "${#mm_undo_stack}" 'load clears history'
  [[ ! -e "$fixture_dir/executed" ]]
  _check_equal 0 "$?" 'shell-like node text never executes'

  _reject_file 'reject unknown header' $'BAD\n0\t0\troot'
  _reject_file 'reject empty tree' 'MM-ZSH-1'
  _reject_file 'reject multiple roots' $'MM-ZSH-1\n0\t0\troot\n0\t0\tother'
  _reject_file 'reject depth jump' $'MM-ZSH-1\n0\t0\troot\n2\t0\tchild'
  _reject_file 'reject negative depth' $'MM-ZSH-1\n0\t0\troot\n-1\t0\tchild'
  _reject_file 'reject arithmetic injection' $'MM-ZSH-1\n0\t0\troot\na[$(print PWNED)]\t0\tchild'
  _reject_file 'reject huge numeric depth' $'MM-ZSH-1\n0\t0\troot\n9999999999999999999999999\t0\tchild'
  _reject_file 'reject invalid fold' $'MM-ZSH-1\n0\t2\troot'
  _reject_file 'reject extra tab' $'MM-ZSH-1\n0\t0\troot\textra'
  _reject_file 'reject escape sequence in file' $'MM-ZSH-1\n0\t0\troot\e[2J'
  _reject_file 'reject blank label in file' $'MM-ZSH-1\n0\t0\t  '
  contents=MM-ZSH-1
  for (( row=0; row<=24; row++ )); do
    contents+=$'\n'"${row}"$'\t0\t'"node ${row}"
  done
  _reject_file 'reject over 24 layers' "$contents"
  contents=$'MM-ZSH-1\n0\t0\troot'
  for (( row=1; row<=500; row++ )); do
    contents+=$'\n1\t0\t'"node ${row}"
  done
  _reject_file 'reject over 500 nodes' "$contents"
  _check_failure 'reject overlong labels' _mm_rename "${(l:301::x:)}"

  # Existing destination must survive all rejected saves.
  print -r -- ORIGINAL > "$fixture_dir/protected.mm"
  zf_ln -s -- "$fixture_dir/protected.mm" "$fixture_dir/link.mm"
  _check_failure 'reject symlink save' _mm_save "$fixture_dir/link.mm"
  contents=$(< "$fixture_dir/protected.mm")
  _check_equal ORIGINAL "$contents" 'symlink target stays intact'
  _check_failure 'reject directory save' _mm_save "$fixture_dir"
  _check_failure 'reject missing directory' _mm_save "$fixture_dir/missing/map.mm"
  mm_depth[1]=4
  _check_failure 'reject invalid in-memory data' _mm_save "$fixture_dir/protected.mm"
  contents=$(< "$fixture_dir/protected.mm")
  _check_equal ORIGINAL "$contents" 'invalid state cannot replace existing file'

  _mm_new 'node 0'
  for (( row=1; row<=35; row++ )); do
    _mm_rename "node $row"
  done
  _check_equal 30 "${#mm_undo_stack}" 'undo history limit'
  for (( row=1; row<=30; row++ )); do
    _mm_undo
  done
  _check_equal 'node 5' "${mm_text[1]}" 'history keeps newest 30 states'
  _check_failure 'exhausted undo reports failure' _mm_undo
  for (( row=1; row<=30; row++ )); do
    _mm_redo
  done
  _check_equal 'node 35' "${mm_text[1]}" '30-step redo restores latest state'
  _check_failure 'exhausted redo reports failure' _mm_redo
  _mm_save "$fixture_dir/history.mm"
  _mm_undo
  _check_equal 1 "$mm_dirty" 'undo after save is dirty'

  _mm_new 'root'
  for (( row=1; row<=23; row++ )); do
    _mm_insert child "node $row"
  done
  _check_equal 24 "${#mm_text}" '24 layers allowed'
  _check_failure 'cannot insert 25th layer' _mm_insert child 'too deep'
  _mm_new 'root'
  mm_selected=1
  for (( row=1; row<=499; row++ )); do
    mm_text+=("node $row")
    mm_depth+=(1)
    mm_fold+=(0)
  done
  _mm_save "$fixture_dir/limit.mm"
  _check_equal 0 "$?" '500 nodes can be saved'
  _check_failure 'cannot insert 501st node' _mm_insert child 'too many'
} always {
  zf_rm -rf -- "$fixture_dir"
}

print -r -- "$checks checks, $failures failures (PATH empty during all model operations)"
(( failures == 0 ))
