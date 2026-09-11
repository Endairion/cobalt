'use strict';

/**
 * Does this statement only read?
 *
 * Used to decide whether a benchmark may simply run the thing N times. Leading
 * comments are stripped first, and a CTE is only read-only if it contains no
 * data-modifying branch -- `with x as (delete ... returning *) select ...` very
 * much writes.
 */
function isReadOnlyStatement(sql) {
  let s = String(sql || '');
  // strip leading comments and whitespace
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, '');
    s = s.replace(/^--[^\n]*\n?/, '');
    s = s.replace(/^\/\*[\s\S]*?\*\//, '');
    if (s === before) break;
  }
  if (!/^(with|select|table|values|explain|show)\b/i.test(s)) return false;
  if (/^with\b/i.test(s) && /\b(insert|update|delete|merge)\b/i.test(s)) return false;
  return true;
}

module.exports = { isReadOnlyStatement };
