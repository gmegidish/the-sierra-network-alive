// Names for TSN message types and human-readable decoders for both
// directions. Shared by the server (logs every inbound client message) and
// the client tools (print host replies). Pure, no I/O.
// Layouts: docs/protocol.md "Layer 3" and "Layer 4".

import { decodeMessage, decodePassword } from './wire.js';

/**
 * @typedef {Object} DescribedMessage
 * @property {number} type  first byte
 * @property {string} name
 * @property {Record<string, unknown>} fields
 */

/** Client -> host message types (first byte, TSN(4) first arg). */
export const CLIENT = Object.freeze({
  SEND: 2,
  RSEND: 3,
  LOCK: 4,
  JOIN_NET: 7,
  LEAVE_NET: 9,
  JOIN_GROUP: 10,
  LEAVE_GROUP: 11,
  WORD_PROPERTIES: 13,
  STRING_PROPERTY: 14,
  OLD_LOGIN: 22,
  SAID: 28,
  REGISTER: 30,
  GET_MEMBERS: 31,
  GET_OBJECT: 32,
  SESSION_34: 34,
  HOST_INFO: 36,
  SESSION_37: 37,
  PERSONA: 40,
  CHANGE_PASSWORD: 44,
  SESSION_45: 45,
  LANDS: 47,
  LOGIN: 53,
});

/** Sub-types the client sends during startup (second byte). */
export const CLIENT_SUB = Object.freeze({
  SESSION_SID: 4,          // 34/4
  HOST_NUMBER_REQUEST: 5,  // 36/5
  HOST_ADDR: 1,            // 36/1
  LAND_ADDR: 6,            // 36/6
  GAME_INFO: 7,            // 36/7 (INN): gameinfo.tim stamp
  SESSION_45_SID: 1,       // 45/1
  FLAGS_18: 18,            // 37/18
  FLAGS_32: 32,            // 37/32
  PERSONA_NAME: 4,         // 40/4
  NEW_PASSWORD: 2,         // 44/2
  LAND_REQUEST: 1,         // 47/1
});

/** Host -> client commands (first byte), module 59951 Message dispatch. */
export const HOST = Object.freeze({
  OK: 0,
  FAIL_OR_DONE: 1,
  USER_MSG: 2,
  SID_ASSIGN: 8,
  DISPOSE: 9,
  HOST_INFO: 36,
  LANDS: 47,
});

/** Host 47 msgType values (byte 1). */
export const HOST_LANDS_SUB = Object.freeze({ INFO: 1, LIST: 2 });
/** Host 36 type 5 carries the host number word at offset 2. */
export const HOST_INFO_HOST_NUMBER = 5;
export const HOST_INFO_GAME_INFO = 7;
/** Login replies name the old login type 22 as whichCmd (byte 4). */
export const LOGIN_WHICH_CMD = 22;
export const LOGIN_BAD_PASSWORD_SUB = 9;
export const LOGIN_PASSWORD_BYTES = 11;
/** Fixed head of message 53 before the password ('bbwbbbbwwb'). */
const LOGIN_HEAD_FORMAT = 'bbwbbbbwwb';
const LOGIN_HEAD_BYTES = 13;
const LAND_RECORD_BYTES = 12;
// header: type, sub, toSid w, fromSid w, 4 zero bytes, count w (see src/net/host-messages.js landList)
const LAND_LIST_RECORDS_OFFSET = 12;

/** @param {ArrayLike<number>} bytes @returns {string} */
export function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** @param {string[]} names @param {Array<unknown>} values @returns {Record<string, unknown>} */
function zip(names, values) {
  return Object.fromEntries(names.map((name, i) => [name, values[i]]));
}

/** @param {Uint8Array} bytes @returns {Record<string, unknown>} */
export function decodeLogin(bytes) {
  const head = decodeMessage(LOGIN_HEAD_FORMAT, bytes);
  const password = bytes.subarray(LOGIN_HEAD_BYTES, LOGIN_HEAD_BYTES + LOGIN_PASSWORD_BYTES);
  const [name] = decodeMessage('s', bytes.subarray(LOGIN_HEAD_BYTES + LOGIN_PASSWORD_BYTES));
  return {
    ...zip(['type', 'sub', 'toSid', 'number', 'major', 'minor', 'revision', 'g262', 'g261', 'passwordFromFile'], head),
    password: decodePassword(password),
    name,
  };
}

/** @param {Uint8Array} bytes @returns {Record<string, unknown>} */
export function decodeJoinNet(bytes) {
  return zip(['type', 'zero', 'objectId', 'flags', 'number', 'arg1', 'prop'], decodeMessage('wwwbbww', bytes));
}

/** @type {Record<number, { name: string, decode: (bytes: Uint8Array) => Record<string, unknown> }>} */
const CLIENT_DECODERS = {
  [CLIENT.LOGIN]: { name: 'login', decode: decodeLogin },
  [CLIENT.JOIN_NET]: { name: 'joinNet', decode: decodeJoinNet },
  [CLIENT.SESSION_34]: { name: 'session34', decode: subWithWords },
  [CLIENT.HOST_INFO]: { name: 'hostInfo', decode: subWithWords },
  [CLIENT.SESSION_37]: { name: 'session37', decode: subWithWords },
  [CLIENT.SESSION_45]: { name: 'session45', decode: subWithWords },
  [CLIENT.LANDS]: { name: 'lands', decode: subWithWords },
  [CLIENT.PERSONA]: { name: 'persona', decode: (b) => zip(['type', 'sub', 'name'], decodeMessage('bbs', b)) },
  [CLIENT.CHANGE_PASSWORD]: { name: 'changePassword', decode: subWithBytes },
  [CLIENT.SEND]: { name: 'send', decode: objectMessage },
  [CLIENT.RSEND]: { name: 'rsend', decode: objectMessage },
  [CLIENT.SAID]: { name: 'said', decode: objectMessage },
  [CLIENT.LOCK]: { name: 'lock', decode: objectWords },
  [CLIENT.JOIN_GROUP]: { name: 'joinGroup', decode: objectWords },
  [CLIENT.LEAVE_GROUP]: { name: 'leaveGroup', decode: objectWords },
  [CLIENT.WORD_PROPERTIES]: { name: 'setWordProperties', decode: wordProperties },
  [CLIENT.STRING_PROPERTY]: { name: 'setStringProperty', decode: stringProperty },
  [CLIENT.GET_MEMBERS]: { name: 'getMembers', decode: (b) => ({ ...objectHead(b), offsets: wordsFrom(b, OBJECT_PAYLOAD_OFFSET) }) },
  [CLIENT.GET_OBJECT]: { name: 'getObject', decode: (b) => ({ ...objectHead(b), offsets: wordsFrom(b, OBJECT_PAYLOAD_OFFSET) }) },
};

/** Object messages: type b, sub b, toSid w, fromSid w (0xffff = public), payload from 6. */
const OBJECT_PAYLOAD_OFFSET = 6;

/** @param {Uint8Array} bytes */
function objectHead(bytes) {
  return zip(['type', 'sub', 'toSid', 'fromSid'], decodeMessage('bbww', bytes));
}

/** @param {Uint8Array} bytes @param {number} start @returns {number[]} LE words */
function wordsFrom(bytes, start) {
  const words = [];
  for (let at = start; at + 1 < bytes.length; at += 2) {
    words.push(bytes[at] | (bytes[at + 1] << 8));
  }
  return words;
}

/** @param {Uint8Array} bytes */
function objectWords(bytes) {
  return { ...objectHead(bytes), words: wordsFrom(bytes, OBJECT_PAYLOAD_OFFSET) };
}

/** 2 / 3 / 28: msgType w, then the message body. @param {Uint8Array} bytes */
function objectMessage(bytes) {
  const [msgType] = wordsFrom(bytes.subarray(OBJECT_PAYLOAD_OFFSET, OBJECT_PAYLOAD_OFFSET + 2), 0);
  return { ...objectHead(bytes), msgType, body: hex(bytes.subarray(OBJECT_PAYLOAD_OFFSET + 2)) };
}

/** 13: (offset, value) word pairs. @param {Uint8Array} bytes */
function wordProperties(bytes) {
  const words = wordsFrom(bytes, OBJECT_PAYLOAD_OFFSET);
  const properties = {};
  for (let i = 0; i + 1 < words.length; i += 2) {
    properties[words[i]] = words[i + 1];
  }
  return { ...objectHead(bytes), properties };
}

/** 14: offset w, then the zero-terminated text. @param {Uint8Array} bytes */
function stringProperty(bytes) {
  const [offset, text] = decodeMessage('ws', bytes.subarray(OBJECT_PAYLOAD_OFFSET));
  return { ...objectHead(bytes), offset, text };
}

/** 'bbw+' style: type, sub, then LE words. @param {Uint8Array} bytes */
function subWithWords(bytes) {
  const words = [];
  for (let at = 2; at + 1 < bytes.length; at += 2) {
    words.push(bytes[at] | (bytes[at + 1] << 8));
  }
  return { type: bytes[0], sub: bytes[1], words };
}

/** @param {Uint8Array} bytes */
function subWithBytes(bytes) {
  return zip(['type', 'sub', 'bytes'], decodeMessage('bb+', bytes));
}

/**
 * Decode a client -> host message for logging. Never throws.
 * @param {Uint8Array} bytes
 * @returns {DescribedMessage}
 */
export function describeClientMessage(bytes) {
  return describeWith(CLIENT_DECODERS, bytes);
}

/**
 * @param {Record<number, { name: string, decode: (bytes: Uint8Array) => Record<string, unknown> }>} table
 * @param {Uint8Array} bytes
 * @returns {DescribedMessage}
 */
function describeWith(table, bytes) {
  const type = bytes.length > 0 ? bytes[0] : -1;
  const entry = table[type];
  if (!entry) {
    return { type, name: 'unknown', fields: { hex: hex(bytes) } };
  }
  try {
    return { type, name: entry.name, fields: entry.decode(bytes) };
  } catch (error) {
    return { type, name: `${entry.name}?`, fields: { hex: hex(bytes), error: String(error) } };
  }
}

/** cmd 0: whichCmd @4, whichSub @5; a login OK carries privilege w5, flag @7, w8. @param {Uint8Array} bytes */
function decodeOk(bytes) {
  if (bytes[4] === LOGIN_WHICH_CMD) {
    return zip(['cmd', 'flags', 'toSid', 'whichCmd', 'privilege', 'expiredFlag', 'w8'], decodeMessage('bbwbwbw', bytes));
  }
  return zip(['cmd', 'flags', 'toSid', 'whichCmd', 'whichSub'], decodeMessage('bbwbb', bytes));
}

/** cmd 1: whichCmd @4, whichSub @5, numTries @7, text from 8. @param {Uint8Array} bytes */
function decodeFailOrDone(bytes) {
  return {
    ...zip(['cmd', 'flags', 'toSid', 'whichCmd', 'whichSub'], decodeMessage('bbwbb', bytes)),
    ...(bytes.length > 7 ? { numTries: bytes[7] } : {}),
    ...(bytes.length > 8 ? { text: textFrom(bytes, 8) } : {}),
  };
}

/** @param {Uint8Array} bytes @param {number} offset @returns {string} */
function textFrom(bytes, offset) {
  const [text] = decodeMessage('s', bytes.subarray(offset));
  return /** @type {string} */ (text);
}

/** @param {Uint8Array} bytes */
function decodeLandList(bytes) {
  const [cmd, msgType, toSid] = decodeMessage('bbw', bytes);
  if (msgType !== HOST_LANDS_SUB.LIST) {
    return { cmd, msgType, toSid, tail: hex(bytes.subarray(4)) };
  }
  const [, , , , , , count] = decodeMessage('bbwwwww', bytes);
  return { cmd, msgType, toSid, count, lands: readLandRecords(bytes, Number(count)) };
}

/** @param {Uint8Array} bytes @param {number} count @returns {Array<Record<string, unknown>>} */
function readLandRecords(bytes, count) {
  const lands = [];
  let at = LAND_LIST_RECORDS_OFFSET;
  for (let i = 0; i < count && at + LAND_RECORD_BYTES <= bytes.length; i += 1) {
    const record = Array.from(bytes.subarray(at, at + LAND_RECORD_BYTES));
    const name = textFrom(bytes, at + LAND_RECORD_BYTES);
    lands.push({ name, record });
    at += LAND_RECORD_BYTES + name.length + 1;
  }
  return lands;
}

/** @type {Record<number, { name: string, decode: (bytes: Uint8Array) => Record<string, unknown> }>} */
const HOST_DECODERS = {
  [HOST.OK]: { name: 'ok', decode: decodeOk },
  [HOST.FAIL_OR_DONE]: { name: 'failOrDone', decode: decodeFailOrDone },
  [HOST.SID_ASSIGN]: { name: 'sidAssign', decode: (b) => zip(['cmd', 'flags', 'objectId', 'zero', 'sid'], decodeMessage('bbwww', b)) },
  [HOST.HOST_INFO]: { name: 'hostInfo', decode: (b) => zip(['cmd', 'type', 'value'], decodeMessage('bbw', b)) },
  [HOST.LANDS]: { name: 'lands', decode: decodeLandList },
};

/**
 * Decode a host -> client message for display. Never throws.
 * @param {Uint8Array} bytes
 * @returns {DescribedMessage}
 */
export function describeHostMessage(bytes) {
  return describeWith(HOST_DECODERS, bytes);
}

/** @param {DescribedMessage} described @returns {string} */
export function formatDescribed({ type, name, fields }) {
  return `${type} ${name} ${JSON.stringify(fields)}`;
}
