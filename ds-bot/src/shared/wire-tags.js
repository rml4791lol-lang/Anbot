// Wire syntax, not words: a model that writes its tool call in DSML form can
// leave the tags in the text block DSH hands the chat, and some models wrap the
// whole answer in <final> or use antml-style tags, whose closing fragments
// (`</antml>`, `</clusive>`) have also reached a message. None of this belongs
// in a message, on either side of the plugin: the host reads text through this
// on the way to storage, delivery and the search index; the client reads it on
// the way to the screen.
// The CJK and ASCII pipe spellings both appear, and a copied tag can lose a bar,
// so the bars are taken loosely.
const WIRE_TAG = /<\s*\/?\s*(?:[｜|]+\s*)?(?:DSML|antml|final|clusive)(?::[A-Za-z_-]+)?\s*(?:(?:[｜|]+\s*)?(?:invoke|calls|parameter)\b)?[^>\n]{0,200}>/giu
const HAS_WIRE_TAG = /DSML|antml|final|clusive/i
// Text inside a fenced block is code or a quoted sample: leave it exactly as written.
const FENCE = /(^|\n)(```|~~~)[\s\S]*?\n\2[^\n]*(\n|$)/g

// A tag alone on its line leaves no line behind; an inline one leaves one space.
const stripLines = (chunk) => {
  if (!HAS_WIRE_TAG.test(chunk)) return chunk
  const kept = []
  for (const line of chunk.split('\n')) {
    if (!HAS_WIRE_TAG.test(line)) {
      kept.push(line)
      continue
    }
    const left = line.replace(WIRE_TAG, '').replace(/[ \t]{2,}/g, ' ').trim()
    if (left !== '') kept.push(left)
  }
  return kept.join('\n')
}

export const stripWireTags = (text) => {
  const value = String(text ?? '')
  if (!HAS_WIRE_TAG.test(value)) return value
  let out = ''
  let at = 0
  for (const match of value.matchAll(FENCE)) {
    out += stripLines(value.slice(at, match.index))
    out += match[0]
    at = match.index + match[0].length
  }
  // Edge newlines left by removed tag lines go; a first line's own indentation stays
  // (Markdown code or a quoted sample must look unchanged).
  return (out + stripLines(value.slice(at)))
    .replace(/^[ \t]*\n+/, '')
    .replace(/\n+[ \t]*$/, '')
    .replace(/[ \t]+$/, '')
}
