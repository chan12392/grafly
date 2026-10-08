; Function and filter statements carry their name in the function_name token.
(function_statement
  (function_name) @name) @definition.function

; Cmdlet and script-function invocations are commands. Unmatched commands
; remain unresolved; Grafly uses its existing same-file/unique-name rules.
(command
  (command_name) @name) @reference.call
