const yaml = require('js-yaml');

// A YAML loader that keeps text as text. The default schema turns `1e3` into 1000, `0x10` into 16,
// `0777` into 511, `1.10` into 1.1, `+1` into 1, `2001-12-14` into a Date and a 20-digit number
// into a rounded one: all silently, in fields like environment variables where the exact text
// matters. Here a plain scalar becomes a number only when writing the number back gives the same
// text (`3000`, `0.5`, `-2`); everything else stays a string. Booleans (true/false only), null,
// anchors, aliases and merge keys work as usual; timestamps are plain strings.
const keep = yaml.DEFAULT_SCHEMA.implicit.filter((t) => !/:(int|float|timestamp)$/.test(t.tag));
const plain = (d) => /^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/.test(d) && String(Number(d)) === d;
const intType = new yaml.Type('tag:yaml.org,2002:int', {
  kind: 'scalar',
  resolve: (d) => plain(d) && !d.includes('.') && Number.isSafeInteger(Number(d)),
  construct: Number,
  predicate: Number.isInteger,
});
const floatType = new yaml.Type('tag:yaml.org,2002:float', {
  kind: 'scalar',
  resolve: (d) => plain(d) && d.includes('.'),
  construct: Number,
  predicate: (o) => typeof o === 'number',
});
// `explicit` (not `include`) so the !!str tag keeps working.
const STRICT = new yaml.Schema({ explicit: [...yaml.FAILSAFE_SCHEMA.explicit], implicit: [...keep, intType, floatType] });

const MAX_ALIASES = 200;

// `?` as the YAML "complex key" indicator: at the start of a line (also after `- ` list markers),
// or right after `{`, `[` or `,` in flow style, followed by whitespace or the end of the line.
const COMPLEX_KEY = /(?:^|[\r\n])[ \t]*(?:-[ \t]+)*\?(?:[ \t\r\n]|$)|[{[,][ \t]*\?(?:[ \t\r\n]|$)/;

// An alias is `*` followed by a name, and a name can be almost anything (js-yaml accepts é, `.`, `+`),
// so match any non-space, non-flow character after a `*` that starts a token.
const ALIAS = /(?:^|[\s,[{:(-])\*[^\s,[\]{}]/g;

// A config uses a handful of anchors at most. Complex keys (`? [a, b]`) and masses of aliases are
// the way to make a small file expensive to parse (each alias copies its anchor), so refuse them
// before parsing.
function loadYaml(text) {
  if (COMPLEX_KEY.test(text)) {
    throw new Error('complex mapping keys ("? ...") are not supported in a config (if this is a line of text inside a quoted or block string that starts with "? ", reword it).');
  }
  const aliases = text.match(ALIAS);
  if (aliases && aliases.length > MAX_ALIASES) throw new Error(`too many YAML aliases (${aliases.length}); a config can use at most ${MAX_ALIASES}.`);
  return yaml.load(text, { schema: STRICT });
}

module.exports = { loadYaml };
