'use strict';

/**
 * The engines Cobalt can talk to.
 *
 * A driver owns everything specific to one database: connecting, how a result
 * reports where its columns came from, the catalog queries behind the sidebar,
 * identifier quoting and placeholder style. Everything else — paging, filtering,
 * the change set a grid edit produces, benchmarking — is written once in db.js
 * against this interface.
 *
 * Adding an engine means adding a file here; nothing in the renderer changes.
 */

const postgres = require('./postgres');
const mysql = require('./mysql');

const DRIVERS = new Map([
  [postgres.id, postgres],
  [mysql.id, mysql],
  // What older saved connections, from before there was a choice, will say.
  ['pg', postgres],
  ['postgresql', postgres],
  ['mariadb', mysql],
]);

/** A saved connection with no engine is Postgres: that is all there used to be. */
function driverFor(engine) {
  const key = String(engine || 'postgres').toLowerCase();
  const d = DRIVERS.get(key);
  if (!d) {
    throw new Error(`Unknown database engine "${engine}". Cobalt speaks ${list().map((x) => x.label).join(' and ')}.`);
  }
  return d;
}

/** For the engine picker in the connection dialog. */
function list() {
  return [postgres, mysql].map((d) => ({
    id: d.id,
    label: d.label,
    defaultPort: d.defaultPort,
    defaultDatabase: d.defaultDatabase,
    hasSchemas: d.hasSchemas,
    schemaWord: d.schemaWord,
  }));
}

module.exports = { driverFor, list, postgres, mysql };
