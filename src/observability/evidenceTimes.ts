/**
 * What an exported document says about its timestamps. UnodeAi stamps every instant in UTC. A reader in another
 * time zone must not have to know that a trailing `Z` says so, or guess whether a time is local.
 */
export const UTC_TIMESTAMPS_NOTE = 'Timestamps in this document are UTC (Coordinated Universal Time), in ISO 8601 form with a trailing `Z`. They are not local times.';

/** The same statement for a document that carries no Markdown. */
export const UTC_TIMESTAMPS_PLAIN = 'Every timestamp is UTC (Coordinated Universal Time), in ISO 8601 form with a trailing Z; none is a local time.';
