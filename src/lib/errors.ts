/** An error whose message is written for the person using the app, so it can be shown to them as it is. */
export class UserError extends Error {}

/** Shown for anything else; the real error goes to the server log. */
export const GENERIC_ERROR = "Something went wrong. Try again in a minute.";
