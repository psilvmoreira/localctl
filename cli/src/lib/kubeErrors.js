// How to read what kubectl says when a command fails. Matching a loose phrase such as "not found"
// is dangerous: a Forbidden message naming a missing role, or a missing kubeconfig context, also
// contains it. These helpers match the exact API error for the exact object.

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "Error from server (NotFound): namespaces "x" not found" (kind is the plural: namespaces, secrets).
function isNotFound(text, kind, name) {
  return new RegExp(`Error from server \\(NotFound\\): ${escapeRegExp(kind)} "${escapeRegExp(name)}" not found`).test(String(text || ''));
}

// "Error from server (Conflict): ..." / "Error from server (AlreadyExists): ..."
const isConflict = (text) => /Error from server \((Conflict|AlreadyExists)\)/.test(String(text || ''));
const isAlreadyExists = (text) => /Error from server \(AlreadyExists\)/.test(String(text || ''));

// First line of a message, cut to a sensible size: a hostile or broken kubectl can print megabytes.
function firstLine(text, max = 300) {
  const line = String(text || '').trim().split('\n')[0];
  return line.length > max ? `${line.slice(0, max)}...` : line;
}

module.exports = { isNotFound, isConflict, isAlreadyExists, firstLine };
