export const codes = ['INVALID_INPUT','NOT_IN_HERDR','WRONG_ROLE','HC_UNAVAILABLE','HC_ERROR','INVALID_RESPONSE','PROCESS_TIMEOUT','PERMISSION_REQUIRED','PERMISSION_DENIED','TEMPLATE_NOT_FOUND','NAME_IN_USE','INVALID_WORKTREE','FIRST_MESSAGE_NOT_SENT','SPAWN_OUTCOME_UNKNOWN','NOT_FOUND','AMBIGUOUS_ADDRESS','NOT_CHILD','BLOCKED','FINISHED','DELIVERY_UNKNOWN','STOP_FAILED','REMOVE_FAILED','NO_PARENT','PARENT_UNAVAILABLE','REQUEST_ID_CONFLICT','DELIVERY_PENDING','JOURNAL_FULL'] as const;
export type Code = typeof codes[number];
export type Effect = 'none' | 'applied' | 'unknown';
export type Data = Record<string, any>;
export type Envelope = { ok: true; data: Data } | { ok: false; error: { code: Code; message: string; hint: string; effect: Effect; details?: unknown }; data: Data };
export function success(data: Data): Envelope { return { ok: true, data }; }
export function failure(code: Code, message: string, effect: Effect = 'none', data: Data = {}, details?: unknown, hint = 'Read the current state before retrying.'): Envelope {
  return { ok: false, error: { code, message, hint, effect, ...(details === undefined ? {} : { details }) }, data };
}
export class Fault extends Error {
  constructor(public code: Code, message: string, public details?: unknown, public effect: Effect = 'none', public data: Data = {}) { super(message); }
}
