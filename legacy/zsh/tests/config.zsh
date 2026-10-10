#!/bin/zsh
emulate -R zsh
source "${0:A:h:h}/src/config.zsh" || exit 1
zmodload -F zsh/files b:zf_mkdir b:zf_mv b:zf_rm b:zf_ln || exit 1
zmodload -F zsh/stat b:zstat || exit 1

typeset -A mm_config file_info
typeset mm_message='' REPLY='' mm_config_file=''
typeset fixture_dir="${TMPDIR:-/tmp}/mm-config-test-${$}-${RANDOM}"
fixture_dir=${fixture_dir:a}
typeset MM_CONFIG_FILE="$fixture_dir/nested/config" old_file old_map actual
typeset -i checks=0 failures=0
zf_mkdir -- "$fixture_dir" || exit 1
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

_reject_config() {
  emulate -L zsh
  local description=$1 body=$2
  print -r -- "$body" >| "$MM_CONFIG_FILE"
  mm_config[node-width]=44
  _check_failure "$description" _mm_config_load
  _check_equal 32 "${mm_config[node-width]}" "$description resets to defaults"
  _check_equal Tab "${mm_config[key.child]}" "$description never uses partial data"
}

{
  _mm_config_load
  _check_equal 0 "$?" 'absent configuration uses defaults'
  _check_equal 19 "${#mm_config}" 'all default values are present'
  _check_equal '' "${mm_config[save-dir]}" 'default save directory is current directory'
  _check_equal 32 "${mm_config[node-width]}" 'default node width'
  _check_equal Tab "${mm_config[key.child]}" 'default child binding'
  [[ ! -e $MM_CONFIG_FILE ]]
  _check_equal 0 "$?" 'loading missing config does not create file'

  _mm_expand_path '~'
  _check_equal "$HOME" "$REPLY" 'tilde expands without changing HOME'
  _mm_expand_path '~/maps with spaces'
  _check_equal "$HOME/maps with spaces" "$REPLY" 'tilde slash expands'
  _mm_expand_path '~somebody/maps'
  _check_equal '~somebody/maps' "$REPLY" 'other-user tilde remains literal'
  _mm_expand_path '\$(print PWNED); ${HOME}; `echo hi`'
  _check_equal '\$(print PWNED); ${HOME}; `echo hi`' "$REPLY" 'shell-like path remains literal'

  _mm_config_set node-width 48
  _check_equal 0 "$?" 'set persists with empty PATH and missing config directory'
  _check_equal 48 "${mm_config[node-width]}" 'set updates live map'
  [[ -f $MM_CONFIG_FILE ]]
  _check_equal 0 "$?" 'config file created'
  zstat -H file_info -- "$MM_CONFIG_FILE"
  _check_equal 384 "$((file_info[mode] & 8#777))" 'config permissions are 0600'
  _mm_config_get node-width
  _check_equal 48 "$REPLY" 'get returns value through REPLY'
  _mm_config_load
  _check_equal 48 "${mm_config[node-width]}" 'persisted values load'
  _mm_config_set node-width 08
  _check_equal 8 "${mm_config[node-width]}" 'valid number canonicalized without octal interpretation'
  _mm_config_set node-width 80
  _check_equal 80 "${mm_config[node-width]}" 'maximum node width accepted'

  old_file=$(< "$MM_CONFIG_FILE")
  old_map=$(_mm_config_show)
  _check_failure 'existing primary binding conflicts' _mm_config_set key.child e
  [[ $mm_message == *key.child* && $mm_message == *key.edit* ]]
  _check_equal 0 "$?" 'conflict identifies both actions'
  _check_equal "$old_file" "$(< "$MM_CONFIG_FILE")" 'conflict leaves file unchanged'
  _check_equal "$old_map" "$(_mm_config_show)" 'conflict leaves effective configuration unchanged'
  _check_failure 'question mark conflicts while default help uses it' _mm_config_set key.edit '?'
  _mm_config_set key.help F1
  _check_equal 0 "$?" 'help can use reserved F1'
  _mm_config_set key.edit '?'
  _check_equal 0 "$?" 'question mark can be reused after help moves'
  _check_failure 'F1 cannot be assigned to other actions' _mm_config_set key.delete F1
  _check_failure 'colon cannot be assigned' _mm_config_set key.help ':'
  _check_failure 'fullwidth colon remains reserved' _mm_config_set key.edit '：'
  _check_failure 'fullwidth question mark remains reserved' _mm_config_set key.delete '？'
  _check_failure 'reset detects conflict with new owner of default key' _mm_config_reset key.help
  _check_equal F1 "${mm_config[key.help]}" 'failed reset keeps current value'
  _mm_config_set node-width 64
  _mm_config_set save-dir .
  _mm_config_reset keys
  _check_equal 0 "$?" 'all-key reset resolves swapped keys atomically'
  _check_equal '?' "${mm_config[key.help]}" 'all-key reset restores help'
  _check_equal e "${mm_config[key.edit]}" 'all-key reset restores edit'
  _check_equal 64 "${mm_config[node-width]}" 'all-key reset preserves node width'
  _check_equal "$PWD" "${mm_config[save-dir]}" 'all-key reset preserves save directory'
  _mm_config_load
  _check_equal '?' "${mm_config[key.help]}" 'all-key reset is persisted'
  _mm_config_reset
  _check_equal '?' "${mm_config[key.help]}" 'reset all restores help'
  _check_equal e "${mm_config[key.edit]}" 'reset all restores edit'
  _mm_config_set key.edit j
  _check_equal 0 "$?" 'aliases outside primary map do not conflict'
  _mm_config_set key.edit 编
  _check_equal 编 "${mm_config[key.edit]}" 'single printable Unicode key accepted'
  _mm_config_set key.delete Delete
  _check_equal Delete "${mm_config[key.delete]}" 'named Delete accepted'
  _mm_config_reset key.delete
  _check_equal d "${mm_config[key.delete]}" 'reset one restores its default'
  _check_equal 编 "${mm_config[key.edit]}" 'reset one preserves other settings'

  _check_failure 'unknown key rejected' _mm_config_set unknown value
  _check_failure 'arithmetic-like key rejected' _mm_config_set 'x[$(print PWNED)]' value
  _check_failure 'unknown get key rejected' _mm_config_get missing
  _check_failure 'unknown reset key rejected' _mm_config_reset missing
  _check_failure 'negative width rejected' _mm_config_set node-width -1
  _check_failure 'small width rejected' _mm_config_set node-width 7
  _check_failure 'large width rejected' _mm_config_set node-width 81
  _check_failure 'huge width rejected before arithmetic' _mm_config_set node-width 99999999999999999
  _check_failure 'width expression rejected' _mm_config_set node-width '8+1'
  _check_failure 'width command injection rejected' _mm_config_set node-width '\$(print PWNED)'
  _check_failure 'tab character rejected as key' _mm_config_set key.edit $'\t'
  _check_failure 'literal space requires named Space' _mm_config_set key.edit ' '
  _check_failure 'empty key rejected' _mm_config_set key.edit ''
  _check_failure 'multicharacter key rejected' _mm_config_set key.edit gg
  _check_failure 'escape sequence rejected' _mm_config_set key.edit $'\e[A'

  zf_mkdir -- "$fixture_dir/脑图 files"
  _mm_config_set save-dir "$fixture_dir/脑图 files"
  _check_equal "$fixture_dir/脑图 files" "${mm_config[save-dir]}" 'Unicode save directory with spaces persists'
  _mm_config_load
  _check_equal "$fixture_dir/脑图 files" "${mm_config[save-dir]}" 'save directory round trip'
  _mm_config_set save-dir .
  _check_equal "$PWD" "${mm_config[save-dir]}" 'relative save directory stored as absolute'
  _check_failure 'missing save directory rejected on set' _mm_config_set save-dir "$fixture_dir/missing"
  [[ ! -d "$fixture_dir/missing" ]]
  _check_equal 0 "$?" 'save-dir setting never creates user directories'
  _check_failure 'regular file is not save directory' _mm_config_set save-dir "$MM_CONFIG_FILE"
  _check_failure 'newline in save directory rejected' _mm_config_set save-dir $'/tmp/one\ntwo'
  _mm_config_set save-dir ''
  _check_equal '' "${mm_config[save-dir]}" 'empty save directory accepted'

  print -r -- $'MM-CONFIG-1\nsave-dir\t'"$fixture_dir/deleted" >| "$MM_CONFIG_FILE"
  _mm_config_load
  _check_equal 0 "$?" 'missing saved directory does not prevent load'
  _check_equal "$fixture_dir/deleted" "${mm_config[save-dir]}" 'missing saved directory is retained'
  print -r -- $'MM-CONFIG-1\nkey.edit\t?\nkey.help\tF1' >| "$MM_CONFIG_FILE"
  _mm_config_load
  _check_equal 0 "$?" 'whole-file key swap validates after parsing all lines'
  _check_equal '?' "${mm_config[key.edit]}" 'key swap loaded'
  _check_equal 32 "${mm_config[node-width]}" 'missing file entries retain defaults'
  print -rn -- $'MM-CONFIG-1\nnode-width\t40' >| "$MM_CONFIG_FILE"
  _mm_config_load
  _check_equal 40 "${mm_config[node-width]}" 'last config line needs no final newline'

  _reject_config 'invalid header' $'BAD\nnode-width\t48'
  _reject_config 'unknown config key' $'MM-CONFIG-1\nnode-width\t48\nunknown\tvalue'
  _reject_config 'duplicate config key' $'MM-CONFIG-1\nnode-width\t48\nnode-width\t64'
  _reject_config 'invalid width in file' $'MM-CONFIG-1\nnode-width\t99'
  _reject_config 'missing tab' $'MM-CONFIG-1\nnode-width=48'
  _reject_config 'extra tab' $'MM-CONFIG-1\nnode-width\t48\textra'
  _reject_config 'blank line' $'MM-CONFIG-1\n\nnode-width\t48'
  _reject_config 'conflicting file binding' $'MM-CONFIG-1\nkey.child\te'
  _reject_config 'reserved file binding' $'MM-CONFIG-1\nkey.edit\t:'
  _reject_config 'terminal escape in file' $'MM-CONFIG-1\nkey.edit\t\e[2J'
  _reject_config 'shell injection is not sourced' $'MM-CONFIG-1\nnode-width\t'"\$(print PWNED > '$fixture_dir/executed')"
  [[ ! -e "$fixture_dir/executed" ]]
  _check_equal 0 "$?" 'malicious configuration never executes'

  _mm_config_reset
  _mm_config_set key.help F1
  _mm_config_set key.edit '?'
  old_file=$(< "$MM_CONFIG_FILE")
  old_map=$(_mm_config_show)
  # Deliberately fail only the final rename to exercise atomic failure behavior.
  zf_mv() { return 1; }
  _check_failure 'atomic rename failure reported' _mm_config_set node-width 55
  _check_failure 'all-key reset rename failure reported' _mm_config_reset keys
  unfunction zf_mv
  _check_equal "$old_file" "$(< "$MM_CONFIG_FILE")" 'failed rename preserves original file'
  _check_equal "$old_map" "$(_mm_config_show)" 'failed rename preserves live configuration'
  actual=("${mm_config_file:h}"/.mm-config-*(N))
  _check_equal 0 "${#actual}" 'failed rename cleans up temporary files'

  mm_config_file="$fixture_dir/not-a-directory/config"
  print -r -- ORIGINAL > "$fixture_dir/not-a-directory"
  _check_failure 'unusable parent path rejected' _mm_config_set node-width 54
  _check_equal "$old_map" "$(_mm_config_show)" 'directory creation failure preserves live config'
  _check_equal ORIGINAL "$(< "$fixture_dir/not-a-directory")" 'failed parent creation preserves file'

  zf_ln -s -- "$MM_CONFIG_FILE" "$fixture_dir/link"
  mm_config_file="$fixture_dir/link"
  _check_failure 'symlink config cannot be overwritten' _mm_config_set node-width 53
  _check_equal "$old_file" "$(< "$MM_CONFIG_FILE")" 'symlink target preserved'
  MM_CONFIG_FILE="$fixture_dir/link"
  _check_failure 'symlink config is not loaded' _mm_config_load
  _check_equal 32 "${mm_config[node-width]}" 'symlink load falls back to defaults'
  MM_CONFIG_FILE="$fixture_dir"
  _check_failure 'directory config is not loaded' _mm_config_load
  _check_failure 'directory config cannot be overwritten' _mm_config_set node-width 52

  MM_CONFIG_FILE="$fixture_dir/final/config"
  _mm_config_load
  _mm_config_set node-width 60
  _mm_config_reset node-width
  _mm_config_load
  _check_equal 32 "${mm_config[node-width]}" 'single-key reset persists'
  _mm_config_set node-width 60
  _mm_config_reset
  _mm_config_load
  _check_equal 32 "${mm_config[node-width]}" 'full reset persists'
  old_file=$(< "$MM_CONFIG_FILE")
  actual=$MM_CONFIG_FILE
  MM_CONFIG_FILE=$'/tmp/invalid\nconfig'
  _check_failure 'control characters in config filename rejected' _mm_config_load
  _check_equal '' "$mm_config_file" 'invalid filename cannot leave a previous target active'
  _check_failure 'invalid filename cannot save into an old target' _mm_config_set node-width 77
  _check_equal "$old_file" "$(< "$actual")" 'previous config file remains intact after invalid target'
} always {
  zf_rm -rf -- "$fixture_dir"
}

print -r -- "$checks checks, $failures failures (PATH empty during all config operations)"
(( failures == 0 ))
