/**
 * A scripture reference, e.g. "sb 1.8.40" → ["sb", "1", "8", "40"].
 *
 * Tokens are kept as strings so the first token (the source abbreviation)
 * and numeric tokens compose naturally. Parsing user queries is done by
 * `parseReferenceQuery` in @lib/application.
 */
export type Reference = readonly string[]
