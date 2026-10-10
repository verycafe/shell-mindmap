#!/bin/zsh
# Development assembly only. The resulting mm.zsh has no runtime imports.
emulate -LR zsh
setopt err_exit
local_dir=${0:A:h}
{
  print -r -- '#!/bin/zsh'
  print -r -- '# mm: pure Zsh terminal mind map. Source this file, or copy its mm() function.'
  print -r -- 'mm() {'
  print -r -- '  emulate -L zsh'
  print -r -- '  setopt localtraps'
  print -r -- "  trap '' INT"
  print -r -- '  ('
  print -r -- '  emulate -LR zsh'
  print -r -- '  setopt multibyte'
  for part in model layout config commands help ui; do
    while IFS= read -r line || [[ -n $line ]]; do
      print -r -- "$line"
    done < "$local_dir/src/$part.zsh"
  done
  print -r -- '  _mm_main "$@"'
  print -r -- '  )'
  print -r -- '}'
  print -r -- 'if [[ $ZSH_EVAL_CONTEXT == toplevel ]]; then mm "$@"; fi'
} > "$local_dir/mm.zsh"
