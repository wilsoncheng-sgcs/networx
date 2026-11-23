/**
 * Split a command line into arguments. Whitespace separates arguments;
 * a double-quoted run ("Test results ready") is one argument.
 * An unmatched opening quote takes the rest of the line as one argument.
 */
export function tokenize(raw: string): string[] {
  const args: string[] = []
  const s = raw.trim()
  let i = 0
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++
    if (i >= s.length) break
    if (s[i] === '"') {
      const close = s.indexOf('"', i + 1)
      if (close === -1) {
        args.push(s.slice(i + 1))
        break
      }
      args.push(s.slice(i + 1, close))
      i = close + 1
    } else {
      let j = i
      while (j < s.length && !/\s/.test(s[j]!)) j++
      args.push(s.slice(i, j))
      i = j
    }
  }
  return args
}
