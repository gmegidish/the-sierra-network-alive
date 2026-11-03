// Host -> client message builders, shared by server/session.js and FakeServer (docs/protocol.md "Host to client" and
// "Minimum fake host"). Every builder returns the message bytes without the
// length prefix; LinkEndpoint.sendMessage adds framing.

import { encodeMessage } from './wire.js';
import {
  HOST, HOST_LANDS_SUB, HOST_INFO_HOST_NUMBER, HOST_INFO_GAME_INFO, LOGIN_WHICH_CMD, LOGIN_BAD_PASSWORD_SUB,
} from './catalog.js';

/**
 * @typedef {Object} LoginOkFields
 * @property {number} privilege  word@5: 4 -> g82=3, 128 -> 2, 2 -> 1
 * @property {boolean} [isPasswordExpired]  byte@7 = 11
 * @property {number} [w8]  word@8 -> g253 (0 becomes 1 on the client)
 */

/**
 * @typedef {Object} LoginRejectedFields
 * @property {number} numTries  client hangs up once its tries reach this
 * @property {string} text  shown to the user
 * @property {number} [whichSub]  9 = bad password
 */

/**
 * @typedef {Object} SidAssignFields
 * @property {number} objectId  echo of the joinNet word at offset 4
 * @property {number} sid
 */

/**
 * @typedef {Object} LandRecord
 * One LandAddr line, "%20s %3d %3d %3d %03d.%03d.%03d %03d.%03d.%03d %3d"
 * (module 101 writes it, module 55 block 18 parses it into a land entry).
 * Module 55 drops a line whose hostNumber is 255 or whose landType,
 * landNumber or flags is 0. The chooser lists entries whose landType is the
 * clicked land (LAND.CFG number: 1 CC, 2 SierraLand, 3 LarryLand, 4 MedievaLand).
 * @property {string} name  description shown in the chooser
 * @property {number} hostNumber  byte 0
 * @property {number} landType  byte 1
 * @property {number} landNumber  byte 2
 * @property {number[]} unused  bytes 3-4, read but not written
 * @property {number[]} minVersion  bytes 5-7, major.minor.revision; 0.0.0 for both = any version
 * @property {number[]} maxVersion  bytes 8-10
 * @property {number} flags  byte 11 (landFlags)
 */

/**
 * @typedef {Object} LandListFields
 * @property {number} toSid
 * @property {LandRecord[]} lands
 */

const PASSWORD_EXPIRED = 11;

/** @param {LoginOkFields} fields @returns {Uint8Array} */
// word@8 is the land-access mask: land n needs bit n-1.
const ALL_LANDS_ACCESS = 0xffff;

export function loginOk({ privilege, isPasswordExpired = false, w8 = ALL_LANDS_ACCESS }) {
  return encodeMessage('bbwbwbw', [HOST.OK, 0, 0, LOGIN_WHICH_CMD, privilege, isPasswordExpired ? PASSWORD_EXPIRED : 0, w8]);
}

/** @param {LoginRejectedFields} fields @returns {Uint8Array} */
export function loginRejected({ numTries, text, whichSub = LOGIN_BAD_PASSWORD_SUB }) {
  return encodeMessage('bbwbbbbs', [HOST.FAIL_OR_DONE, 0, 0, LOGIN_WHICH_CMD, whichSub, 0, numTries, text]);
}

/** @param {SidAssignFields} fields @returns {Uint8Array} */
export function sidAssign({ objectId, sid }) {
  return encodeMessage('bbwww', [HOST.SID_ASSIGN, 0, objectId, 0, sid]);
}

/**
 * cmd 1 "done" for a request: whichCmd @4, whichSub @5.
 * @param {number} whichCmd
 * @param {number} whichSub
 * @returns {Uint8Array}
 */
export function done(whichCmd, whichSub) {
  return encodeMessage('bbwbb', [HOST.FAIL_OR_DONE, 0, 0, whichCmd, whichSub]);
}

/**
 * cmd 0 "ok" for a request on object toSid: whichCmd @4 (the lock of a game
 * group is acknowledged this way; LL module 1019 waits for whichCmd 4).
 * @param {number} toSid @param {number} whichCmd @returns {Uint8Array}
 */
export function requestOk(toSid, whichCmd) {
  return encodeMessage('bbwbb', [HOST.OK, 0, toSid, whichCmd, 0]);
}

/**
 * cmd 36 type 7, short form: the caller's gameinfo.cfg is current. INN module
 * 101 (Dialing) writes a longer reply (stamp words + file bytes) to
 * gameinfo.tim/.cfg; either length releases dialScript state 7.
 * @returns {Uint8Array}
 */
export function gameInfoCurrent() {
  return encodeMessage('bbw', [HOST.HOST_INFO, HOST_INFO_GAME_INFO, 0]);
}

/** cmd 36 type 5: hostNumber (g251), 0..200. @param {number} hostNumber @returns {Uint8Array} */
export function hostNumber(hostNumber) {
  return encodeMessage('bbw', [HOST.HOST_INFO, HOST_INFO_HOST_NUMBER, hostNumber]);
}

/** @param {LandRecord} land @returns {Array<number | string>} */
function landRecordArgs({ name, hostNumber, landType, landNumber, unused, minVersion, maxVersion, flags }) {
  return [hostNumber, landType, landNumber, ...unused, ...minVersion, ...maxVersion, flags, name];
}

const LAND_RECORD_FORMAT = 'bbbbbbbbbbbbs';

/**
 * @typedef {Object} LandPopulation
 * @property {number} maximum  capacity, the gauge's right label (254 = not available)
 * @property {number} curSize  people there now (255 = unknown, drawn as "???")
 */

/**
 * cmd 47 msgType 1, the answer to the client's 47/1 (root module 0,
 * ProcessLandInfo): the same 6-byte head and count word as the land list, then
 * per land five bytes: hostNumber, landType, landNumber, maximum, curSize.
 * The client marks lands missing from it "not available".
 * @param {{ toSid: number, lands: LandRecord[], population: (land: LandRecord) => LandPopulation }} fields
 * @returns {Uint8Array}
 */
export function landInfo({ toSid, lands, population }) {
  const bytes = lands.flatMap((land) => {
    const { maximum, curSize } = population(land);
    return [land.hostNumber, land.landType, land.landNumber, maximum, curSize];
  });
  return encodeMessage(`bbwwwww${'b'.repeat(bytes.length)}`, [HOST.LANDS, HOST_LANDS_SUB.INFO, toSid, 0, 0, 0, lands.length, ...bytes]);
}

/**
 * cmd 47 msgType 2: count word@4, then 12 bytes + NUL-terminated name per land.
 * @param {LandListFields} fields
 * @returns {Uint8Array}
 */
export function landList({ toSid, lands }) {
  // Class 125 moves the payload from offset 6 to 0, then reads count at payload w4,
  // records from payload offset 6 → header: type, sub, toSid, fromSid, 4 zero bytes, count.
  const head = encodeMessage('bbwwwww', [HOST.LANDS, HOST_LANDS_SUB.LIST, toSid, 0, 0, 0, lands.length]);
  const records = lands.map((land) => encodeMessage(LAND_RECORD_FORMAT, landRecordArgs(land)));
  return Uint8Array.from([...head, ...records.flatMap((r) => Array.from(r))]);
}

/** Host commands for group membership (module 59951: cmd 10 class 108, 11 class 109, 12 class 107). */
export const HOST_GROUP = Object.freeze({ JOINED: 10, LEFT: 11, MEMBERS: 12 });

/**
 * cmd 10 / 11: `who` joined or left the group object `toSid` (Msg: toSID w2, who w4).
 * @param {number} command HOST_GROUP.JOINED or HOST_GROUP.LEFT
 * @param {number} toSid @param {number} who @returns {Uint8Array}
 */
export function groupChange(command, toSid, who) {
  return encodeMessage('bbww', [command, 0, toSid, who]);
}

/**
 * cmd 40 bank reply to 40/3: msgType 1, whichCmd 3 @4, whichSub 1 @5, then
 * the LarryBucks as a long (low word @6, high word @8).
 * @param {number} toSid @param {number} amount @returns {Uint8Array}
 */
export function bankBalance(toSid, amount) {
  const WORD = 0x10000;
  return encodeMessage('bbwwwww', [40, 3, toSid, 1, 1, amount % WORD, Math.floor(amount / WORD)]);
}

/**
 * cmd 12: the members of group `toSid`, as words from offset 6.
 * @param {number} toSid @param {number[]} members @returns {Uint8Array}
 */
export function groupMembers(toSid, members) {
  return encodeMessage(`bbww${'w'.repeat(members.length)}`, [HOST_GROUP.MEMBERS, 0, toSid, 0, ...members]);
}

/**
 * @typedef {Object} PropertyValue
 * @property {number} offset  property offset (ObjPropOffset), as the client sent it
 * @property {number | string} value  a word, or a string (type 1)
 */

/**
 * @typedef {Object} MemberProperties
 * @property {number} sid
 * @property {PropertyValue[]} values  in the order of the request's offsets
 */

const PROPERTY_TYPE = Object.freeze({ WORD: 0, STRING: 1 });
export const HOST_MEMBER_PROPERTIES = 31;

export const HOST_OBJECT_PROPERTIES = 33;

/**
 * cmd 33 (class 116): properties of object `sid`, the answer to client 32.
 * Header type, 0, toSID w2, fromSID w4; then per property type b (0 word,
 * 1 string), offset w, value (word, or NUL-terminated string).
 * @param {number} sid @param {PropertyValue[]} values @param {(offset: number) => boolean} isStringProperty
 * @returns {Uint8Array}
 */
export function objectProperties(sid, values, isStringProperty) {
  const head = encodeMessage('bbww', [HOST_OBJECT_PROPERTIES, 0, sid, sid]);
  const records = values.map(({ offset, value }) => (isStringProperty(offset)
    ? encodeMessage('bws', [PROPERTY_TYPE.STRING, offset, String(value)])
    : encodeMessage('bww', [PROPERTY_TYPE.WORD, offset, Number(value)])));
  return Uint8Array.from([...head, ...records.flatMap((record) => Array.from(record))]);
}

/**
 * cmd 31 (class 124): requested properties of the members of group `toSid`.
 * Layout: toSID w2, group w4, member count w6, property count w8, then
 * (offset w, type w) per property, then per member: sid w and each value
 * (word, or NUL-terminated string when type 1).
 * @param {number} toSid @param {number} group @param {number[]} offsets
 * @param {MemberProperties[]} members @param {(offset: number) => boolean} isStringProperty
 * @returns {Uint8Array}
 */
export function memberProperties(toSid, group, offsets, members, isStringProperty) {
  const types = offsets.map((offset) => (isStringProperty(offset) ? PROPERTY_TYPE.STRING : PROPERTY_TYPE.WORD));
  const head = encodeMessage(`bbwwww${'ww'.repeat(offsets.length)}`,
    [HOST_MEMBER_PROPERTIES, 0, toSid, group, members.length, offsets.length, ...offsets.flatMap((offset, i) => [offset, types[i]])]);
  const bodies = members.map(({ sid, values }) => encodeMessage(`w${types.map((type) => (type ? 's' : 'w')).join('')}`,
    [sid, ...values.map(({ value }, i) => (types[i] ? String(value) : Number(value)))]));
  return Uint8Array.from([...head, ...bodies.flatMap((body) => Array.from(body))]);
}
