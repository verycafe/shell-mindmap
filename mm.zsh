# Compatibility launcher. The maintained implementation is now the Ink CLI.
if [[ $ZSH_EVAL_CONTEXT == *:file ]]; then
  () {
    local entry="$1/bin/SMM.js"
    functions[SMM]="command node ${(q)entry} \"\$@\""
    functions[mm]=$functions[SMM]
  } "${${(%):-%x}:A:h}"
else
  command node "${${(%):-%x}:A:h}/bin/SMM.js" "$@"
fi
