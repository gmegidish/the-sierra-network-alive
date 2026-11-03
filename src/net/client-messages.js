// Client -> host message builders, byte-identical to what the LSCI scripts
// send through TSN(4, fmt, ...). Used by tools/fake-client.mjs and tests;
// the real client produces the same bytes from module 101 / 196 scripts.

import { encodeMessage, encodePassword } from './wire.js';
import { CLIENT, CLIENT_SUB, LOGIN_PASSWORD_BYTES } from './catalog.js';

/**
 * @typedef {Object} LoginFields
 * @property {number} number  g2.number, account number (sent as a byte)
 * @property {string} password  plain text; scrambled like PASS_SET.DTA
 * @property {string} [name]  persona name or ''
 * @property {number} [major]
 * @property {number} [minor]
 * @property {number} [revision]
 * @property {number} [g262]
 * @property {number} [g261]
 * @property {number} [passwordFromFile]  g184
 */

/**
 * @typedef {Object} JoinNetFields
 * @property {number} objectId  selfObjID, echoed by the host in cmd 8
 * @property {number} number  g2.number
 * @property {number} [flags]  0x81 at login
 * @property {number} [arg1]
 * @property {number} [prop]
 */

/**
 * @typedef {Object} StartupBurstFields
 * @property {number} sid  g2.sid from the cmd 8 reply
 * @property {string} [personaName]  40/4 is only sent when g81 is an object
 * @property {number[]} [hostAddrWords]  two words read from hostaddr.tim (0,0 if absent)
 * @property {number[]} [landAddrWords]  two words read from landaddr.tim
 * @property {number[]} [flags174and175]  g174, g175; 37/18 only when either is set
 */

export const LOGIN_FLAGS_AT_LOGIN = 0x81;
const LOGIN_FORMAT = 'bbwbbbbwwbas';
const NO_ADDR_WORDS = [0, 0];

/** @param {string} password @returns {Uint8Array} 11 bytes, 10 scrambled + NUL */
function passwordField(password) {
  const field = new Uint8Array(LOGIN_PASSWORD_BYTES);
  field.set(encodePassword(password));
  return field;
}

/** Message 53 (module 196 block 10). @param {LoginFields} fields @returns {Uint8Array} */
export function loginMessage({
  number, password, name = '', major = 1, minor = 0, revision = 0, g262 = 0, g261 = 0, passwordFromFile = 1,
}) {
  return encodeMessage(LOGIN_FORMAT, [
    CLIENT.LOGIN, 0, 0, number, major, minor, revision, g262, g261, passwordFromFile,
    LOGIN_PASSWORD_BYTES, passwordField(password), name,
  ]);
}

/** Message 7 (module 60000 block 17). @param {JoinNetFields} fields @returns {Uint8Array} */
export function joinNetMessage({ objectId, number, flags = LOGIN_FLAGS_AT_LOGIN, arg1 = 0, prop = 0 }) {
  return encodeMessage('wwwbbww', [CLIENT.JOIN_NET, 0, objectId, flags, number, arg1, prop]);
}

/**
 * dialScript state 3 (module 101 block 38) in send order, with the
 * conditional messages included as the default client would send them.
 * @param {StartupBurstFields} fields
 * @returns {Uint8Array[]}
 */
export function startupBurstMessages({
  sid, personaName, hostAddrWords = NO_ADDR_WORDS, landAddrWords = NO_ADDR_WORDS, flags174and175 = [0, 0],
}) {
  const [g174, g175] = flags174and175;
  return [
    encodeMessage('bbw', [CLIENT.SESSION_34, CLIENT_SUB.SESSION_SID, sid]),
    encodeMessage('bb', [CLIENT.HOST_INFO, CLIENT_SUB.HOST_NUMBER_REQUEST]),
    ...(g174 || g175 ? [] : [encodeMessage('bbw', [CLIENT.SESSION_45, CLIENT_SUB.SESSION_45_SID, sid])]),
    encodeMessage('bbw+', [CLIENT.HOST_INFO, CLIENT_SUB.HOST_ADDR, ...hostAddrWords]),
    encodeMessage('bbw+', [CLIENT.HOST_INFO, CLIENT_SUB.LAND_ADDR, ...landAddrWords]),
    ...(g174 || g175 ? [encodeMessage('bbw+', [CLIENT.SESSION_37, CLIENT_SUB.FLAGS_18, sid, g174, g175])] : []),
    encodeMessage('bbw+', [CLIENT.SESSION_37, CLIENT_SUB.FLAGS_32, 0, 0, 0]),
    ...(personaName ? [encodeMessage('bbs', [CLIENT.PERSONA, CLIENT_SUB.PERSONA_NAME, personaName])] : []),
  ];
}

/** dialScript state 5: 47/1. @returns {Uint8Array} */
export function landRequestMessage() {
  return encodeMessage('bbw+', [CLIENT.LANDS, CLIENT_SUB.LAND_REQUEST, 0, 0]);
}
