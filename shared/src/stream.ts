// createActionExtractor: incremental parser for Anthropic tool-input partial-JSON
// streams of the shape `{"actions":[{...},{...}]}`. Feed it raw text chunks as
// they arrive (split at arbitrary byte boundaries) and it emits each action
// object the moment its closing brace lands — without waiting for the
// surrounding array or envelope to close.
//
// It is a plain character state machine (in-string / escape / brace depth),
// deliberately dumb: it does not validate action shape, that is the
// sanitizer's job downstream. A slice that fails JSON.parse is dropped
// silently and counted; if the stream ends mid-object, end() reports it.

export function createActionExtractor(onAction: (raw: unknown) => void): {
  push(chunk: string): void
  end(): { trailingGarbage: boolean }
} {
  let depth = 0
  let inString = false
  let escaped = false
  let capturing = false
  let buf = ''
  let malformedCount = 0

  function push(chunk: string): void {
    for (const ch of chunk) {
      if (inString) {
        if (escaped) {
          escaped = false
        } else if (ch === '\\') {
          escaped = true
        } else if (ch === '"') {
          inString = false
        }
        if (capturing) buf += ch
        continue
      }

      if (ch === '"') {
        inString = true
        if (capturing) buf += ch
        continue
      }

      if (ch === '{') {
        depth++
        // envelope must be exactly {"actions":[...]} — a sibling object-valued key before "actions" would be misread as an action
        if (depth === 2) {
          capturing = true
          buf = ''
        }
        if (capturing) buf += ch
        continue
      }

      if (ch === '}') {
        if (capturing) buf += ch
        depth--
        if (depth === 1 && capturing) {
          capturing = false
          let parsed: unknown
          let parseSucceeded = false
          try {
            parsed = JSON.parse(buf)
            parseSucceeded = true
          } catch {
            malformedCount++
          }
          if (parseSucceeded) {
            onAction(parsed)
          }
          buf = ''
        }
        continue
      }

      if (capturing) buf += ch
    }
  }

  function end(): { trailingGarbage: boolean } {
    return { trailingGarbage: capturing }
  }

  return { push, end }
}
